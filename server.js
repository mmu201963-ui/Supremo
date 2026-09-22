const http = require('http');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 3000);
const START = Number(process.env.PAPER_START_CAPITAL || 10000);
const SCAN_MS = Math.max(100, Number(process.env.SCAN_MS || 250));
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 300000);
const FEE = Number(process.env.FEE_RATE || 0.0004);
const SLIP = Number(process.env.SLIPPAGE_RATE || 0.0002);
const MAX_POS = Number(process.env.MAX_POSITIONS || 12);
const MAX_SIDE = Number(process.env.MAX_SIDE || 6);
const MARGIN = Number(process.env.POSITION_MARGIN || 100);
const LEV = Number(process.env.LEVERAGE || 5);
const TP = Number(process.env.PAPER_TP || 0.006);
const SL = Number(process.env.PAPER_SL || 0.004);
const HOLD = Number(process.env.PAPER_MAX_HOLD_MS || 900000);
const MIN_EDGE = Number(process.env.MIN_EDGE || 0.00065);
const FEED_TIMEOUT = Number(process.env.FEED_TIMEOUT_MS || 8000);
const WARMUP_MS = Number(process.env.WARMUP_MS || 8000);
const CANDIDATE_POOL = Number(process.env.CANDIDATE_POOL || 40);
const HISTORY_MS = 60000;

const now = () => Date.now();
const pct = (a, b) => b ? (a / b - 1) * 100 : 0;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

let symbols = new Map();
let ticks = new Map();
let hist = new Map();
let cool = new Map();
let pos = new Map();
let trades = [];
let equity = START;
let realized = 0;
let scanNo = 0;
let connected = false;
let feedMode = 'OFF';
let feedSince = 0;
let lastMessageAt = 0;
let lastDataAt = 0;
let lastScanMs = 0;
let lastScanAt = 0;
let topSignals = [];
let errors = 0;
let reconnects = 0;
let ws = null;
let wsGeneration = 0;
let universeLoadedAt = 0;
let universeSource = 'NONE';
let feedFallbacks = 0;
let firstDataAt = 0;
let dataMessages = 0;
let dataUpdates = 0;
let symbolsUpdatedThisCycle = 0;
let peakEquity = START;
let maxDrawdown = 0;

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'SUPREMO/2.0' } });
  if (!r.ok) throw Error(r.status + ' ' + url);
  return r.json();
}

async function universe() {
  const d = await getJSON('https://fapi.binance.com/fapi/v1/exchangeInfo');
  const next = new Map();
  for (const s of d.symbols || []) {
    if (s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL') next.set(s.symbol, s);
  }
  if (!next.size) throw Error('UNIVERSE_EMPTY');
  symbols = next;
  universeLoadedAt = now();
  universeSource = 'REST_EXCHANGE_INFO';
  console.log(`UNIVERSE_READY=${symbols.size}`);
  return symbols.size;
}

function tick(s, p, v, ts) {
  if (!(p > 0) || !symbols.has(s)) return;
  ticks.set(s, { price: p, volume: v, ts });
  let h = hist.get(s);
  if (!h) hist.set(s, h = []);
  h.push({ ts, price: p });
  while (h.length && ts - h[0].ts > HISTORY_MS) h.shift();
  dataUpdates++;
  lastDataAt = ts;
  if (!firstDataAt) firstDataAt = ts;
}

function feature(s) {
  const t = ticks.get(s), h = hist.get(s) || [];
  if (!t || h.length < 3) return null;
  const p = t.price, ts = t.ts;
  const ret = (w) => {
    for (let i = h.length - 1; i >= 0; i--) {
      if (ts - h[i].ts >= w) return (p / h[i].price - 1);
    }
    return null;
  };
  const r1 = ret(1000), r2 = ret(2000), r5 = ret(5000), r15 = ret(15000);
  if ([r1, r2, r5, r15].some(x => x === null)) return null;
  const velocity = r2 / 2;
  const acceleration = r1 - r2 / 2;
  const persistence = r5 / 5;
  const exhaustion = Math.max(0, Math.abs(r15) - 0.015) * Math.sign(r15 || 0);
  const score = 0.40 * velocity + 0.30 * acceleration + 0.30 * persistence - 0.15 * exhaustion;
  const direction = score >= 0 ? 'LONG' : 'SHORT';
  const grossPotential = Math.abs(score) * 100;
  const estimatedRoundTripCost = (FEE + SLIP) * 2;
  const edge = Math.abs(score) - estimatedRoundTripCost;
  return { symbol:s, price:p, ts, r1:r1*100, r2:r2*100, r5:r5*100, r15:r15*100, velocity, acceleration, persistence, score, direction, grossPotential, estimatedRoundTripCost, edge };
}

function counts() {
  let l = 0, s = 0;
  for (const p of pos.values()) p.side === 'LONG' ? l++ : s++;
  return { l, s };
}

function canOpen(f) {
  if (!f || !feedHealthy() || pos.has(f.symbol)) return false;
  const c = cool.get(f.symbol);
  if (c && now() < c) return false;
  if (now() - feedSince < WARMUP_MS) return false;
  const n = counts();
  return pos.size < MAX_POS && f.edge >= MIN_EDGE &&
    !(f.direction === 'LONG' && n.l >= MAX_SIDE) &&
    !(f.direction === 'SHORT' && n.s >= MAX_SIDE);
}

function openPosition(f) {
  pos.set(f.symbol, {
    symbol: f.symbol,
    side: f.direction,
    entry: f.price,
    openedAt: now(),
    margin: MARGIN,
    signalScore: f.score,
    edge: f.edge
  });
}

function closePosition(p, price, reason) {
  const d = p.side === 'LONG' ? 1 : -1;
  const move = (price / p.entry - 1) * d;
  const gross = p.margin * move * LEV;
  const fees = p.margin * LEV * FEE * 2;
  const slip = p.margin * LEV * SLIP * 2;
  const net = gross - fees - slip;
  realized += net;
  equity = START + realized;
  peakEquity = Math.max(peakEquity, equity);
  maxDrawdown = Math.max(maxDrawdown, peakEquity - equity);
  trades.push({ symbol:p.symbol, side:p.side, entry:p.entry, exit:price, net, reason, heldMs:now()-p.openedAt, score:p.signalScore });
  if (trades.length > 1000) trades.shift();
  cool.set(p.symbol, now() + COOLDOWN_MS);
  pos.delete(p.symbol);
}

function manage() {
  for (const p of [...pos.values()]) {
    const t = ticks.get(p.symbol);
    if (!t) continue;
    const d = p.side === 'LONG' ? 1 : -1;
    const move = (t.price / p.entry - 1) * d;
    if (move >= TP) closePosition(p, t.price, 'TP');
    else if (move <= -SL) closePosition(p, t.price, 'SL');
    else if (now() - p.openedAt >= HOLD) closePosition(p, t.price, 'TIME');
  }
}

function feedHealthy() {
  const age = lastDataAt ? now() - lastDataAt : Infinity;
  return connected && ticks.size > 0 && age < FEED_TIMEOUT;
}

function scan() {
  const st = performance.now();
  scanNo++;
  manage();
  const a = [];
  let updated = 0;
  for (const s of symbols.keys()) {
    if (ticks.has(s)) updated++;
    const f = feature(s);
    if (f) a.push(f);
  }
  symbolsUpdatedThisCycle = updated;
  a.sort((x,y) => Math.abs(y.edge) - Math.abs(x.edge));
  topSignals = a.slice(0, 30);
  if (feedHealthy() && now() - feedSince >= WARMUP_MS) {
    // Rotate through the best eligible candidates instead of repeatedly taking the first symbol.
    const candidates = a.filter(canOpen).slice(0, CANDIDATE_POOL);
    if (candidates.length) {
      candidates.sort((x,y) => (y.edge - x.edge) || (Math.abs(y.score)-Math.abs(x.score)));
      const chosen = candidates[scanNo % Math.min(3, candidates.length)];
      openPosition(chosen);
    }
  }
  lastScanMs = performance.now() - st;
  lastScanAt = now();
}

function state() {
  let u = 0;
  for (const p of pos.values()) {
    const t = ticks.get(p.symbol);
    if (t) {
      const d = p.side === 'LONG' ? 1 : -1;
      u += p.margin * ((t.price / p.entry - 1) * d) * LEV;
    }
  }
  const liveEq = equity + u;
  const coverage = symbols.size ? ticks.size / symbols.size : 0;
  return {
    name:'SUPREMO', version:'4.0', mode:'PAPER', markets:symbols.size,
    ticks:ticks.size, coverage:+coverage.toFixed(4), coveragePct:+(coverage*100).toFixed(1),
    scanNo, lastScanMs:+lastScanMs.toFixed(3), lastScanAt,
    connected, feedMode, feedHealthy:feedHealthy(), feedAgeMs:lastDataAt ? now()-lastDataAt : null,
    feedSince, lastMessageAt, dataMessages, dataUpdates, symbolsUpdatedThisCycle,
    equity:+liveEq.toFixed(2), realized:+realized.toFixed(2), unrealized:+u.toFixed(2),
    positions:[...pos.values()], trades:trades.slice(-50).reverse(), topSignals,
    cooldowns:[...cool.values()].filter(x=>x>now()).length, errors, reconnects,
    maxDrawdown:+maxDrawdown.toFixed(2), universeLoadedAt, universeSource, feedFallbacks, firstDataAt
  };
}

const page = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SUPREMO V4 — Global Low-Latency Profit Engine PAPER</title><style>body{font-family:Arial;background:#070b11;color:#eaf0f8;padding:18px;margin:0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px}.c,.p{background:#111a25;border:1px solid #263448;border-radius:12px;padding:14px;margin-bottom:12px}.b{font-size:24px;font-weight:bold;margin-top:4px}.m{color:#92a1b6;font-size:12px;line-height:1.5}.ok{color:#55e6a5}.bad{color:#ff7184}.warn{color:#ffd166}table{width:100%;border-collapse:collapse;font-size:12px}td,th{padding:7px;border-bottom:1px solid #223044;text-align:right}td:first-child,th:first-child{text-align:left}.scroll{overflow:auto;max-height:430px}.pill{display:inline-block;padding:4px 8px;border-radius:10px;background:#172335;margin:3px;font-size:11px}</style></head><body><h2>SUPREMO V4 — GLOBAL LOW-LATENCY PROFIT ENGINE</h2><div class=m>Binance USD-M público · PAPER · sin API keys · sin órdenes reales</div><div id=status class="p warn">Inicializando feed...</div><div class=grid><div class=c>Mercados<div id=m class=b>—</div></div><div class=c>Datos<div id=t class=b>—</div><div id=cov class=m>—</div></div><div class=c>Scan #<div id=n class=b>—</div></div><div class=c>Scan ms<div id=ms class=b>—</div></div><div class=c>Equity<div id=e class=b>—</div></div><div class=c>PnL<div id=p class=b>—</div></div><div class=c>Posiciones<div id=o class=b>—</div></div><div class=c>Feed<div id=w class=b>—</div></div></div><div class=p><b>RADAR / TOP EDGE</b><div class=m>Ranking rápido: velocidad + aceleración + persistencia − agotamiento. Entrada solo si el edge estimado supera costes mínimos y el feed está sano.</div><div class=scroll><table><thead><tr><th>PAR</th><th>LADO</th><th>EDGE</th><th>SCORE</th><th>1s%</th><th>2s%</th><th>5s%</th><th>15s%</th></tr></thead><tbody id=s></tbody></table></div></div><div class=p><b>TRADES PAPER</b><div class=scroll><table><thead><tr><th>PAR</th><th>LADO</th><th>NETO</th><th>MOTIVO</th><th>TIEMPO</th></tr></thead><tbody id=r></tbody></table></div></div><div class=p><b>DIAGNÓSTICO</b><div id=d class=m>—</div></div><script>const $=id=>document.getElementById(id);async function u(){try{const x=await fetch('/api/state',{cache:'no-store'}).then(r=>r.json());$('m').textContent=x.markets;$('t').textContent=x.ticks;$('cov').textContent=x.coveragePct+'% cobertura real';$('n').textContent=x.scanNo;$('ms').textContent=x.lastScanMs;$('e').textContent='$'+x.equity.toFixed(2);$('p').textContent='$'+x.realized.toFixed(2);$('o').textContent=x.positions.length;$('w').textContent=x.feedHealthy?'OK':'WAIT';$('w').className='b '+(x.feedHealthy?'ok':'bad');$('status').className='p '+(x.feedHealthy?'ok':'warn');$('status').textContent=x.feedHealthy?('FEED OK · '+x.ticks+'/'+x.markets+' mercados con datos · '+x.feedMode):('ESPERANDO FEED · WS '+(x.connected?'conectado':'desconectado')+' · datos '+x.ticks+'/'+x.markets);$('s').innerHTML=x.topSignals.map(a=>'<tr><td>'+a.symbol+'</td><td class='+(a.direction==='LONG'?'ok':'bad')+'>'+a.direction+'</td><td>'+a.edge.toFixed(5)+'</td><td>'+a.score.toFixed(5)+'</td><td>'+a.r1.toFixed(3)+'</td><td>'+a.r2.toFixed(3)+'</td><td>'+a.r5.toFixed(3)+'</td><td>'+a.r15.toFixed(3)+'</td></tr>').join('');$('r').innerHTML=x.trades.map(a=>'<tr><td>'+a.symbol+'</td><td>'+a.side+'</td><td class='+(a.net>=0?'ok':'bad')+'>'+a.net.toFixed(2)+'</td><td>'+a.reason+'</td><td>'+Math.round(a.heldMs/1000)+'s</td></tr>').join('');$('d').innerHTML='mensajes='+x.dataMessages+' · updates='+x.dataUpdates+' · actualizados/ciclo='+x.symbolsUpdatedThisCycle+' · edad feed='+(x.feedAgeMs??'-')+'ms · reconexiones='+x.reconnects+' · errores='+x.errors+' · reconexiones='+x.reconnects+' · fuente='+x.universeSource+' · drawdown máx=$'+x.maxDrawdown.toFixed(2)}catch(e){$('status').textContent='ERROR UI: '+e.message}}setInterval(u,500);u()</script></body></html>`;

const srv = http.createServer((q,r) => {
  if (q.url === '/api/state') {
    r.writeHead(200, {'content-type':'application/json','cache-control':'no-store'});
    return r.end(JSON.stringify(state()));
  }
  r.writeHead(200, {'content-type':'text/html;charset=utf-8','cache-control':'no-store'});
  r.end(page);
});

function parseMessage(raw) {
  let a;
  try { a = JSON.parse(raw); } catch { errors++; return; }
  lastMessageAt = now();
  dataMessages++;
  // Combined streams wrap payload as {stream,data}.
  const payload = a && a.data !== undefined ? a.data : a;
  const arr = Array.isArray(payload) ? payload : [payload];
  let n = 0;
  for (const x of arr) {
    if (x && x.s && x.c) {
      const sym = String(x.s).toUpperCase();
      // The endpoint is already Binance USD-M Futures. If REST exchangeInfo
      // was unavailable, discover USDT symbols directly from the live stream.
      if (!symbols.has(sym) && sym.endsWith('USDT')) {
        symbols.set(sym, { symbol: sym, status: 'TRADING', quoteAsset: 'USDT', contractType: 'PERPETUAL' });
        if (!universeLoadedAt) universeLoadedAt = now();
        if (universeSource === 'NONE') universeSource = 'LIVE_STREAM_DISCOVERY';
      }
      tick(sym, Number(x.c), Number(x.q || 0), Number(x.E || now()));
      n++;
    }
  }
  if (n) feedSince = feedSince || now();
}

function closeSocket() {
  if (!ws) return;
  try { ws.removeAllListeners(); ws.terminate(); } catch {}
  ws = null;
}

function openWebSocket(url, mode, generation) {
  try { ws = new WebSocket(url); }
  catch (e) { errors++; console.error('WS_CREATE_ERROR', e.message); scheduleReconnect(generation); return; }

  ws.on('open', () => {
    if (generation !== wsGeneration) return;
    connected = true;
    feedMode = mode;
    feedSince = now();
    console.log(`WS_CONNECTED=1 mode=${mode}`);
  });
  ws.on('message', raw => { if (generation === wsGeneration) parseMessage(raw); });
  ws.on('error', err => { errors++; console.error('WS_ERROR', err.message); });
  ws.on('close', () => {
    if (generation !== wsGeneration) return;
    connected = false;
    feedMode = 'RECONNECTING';
    console.log('WS_CLOSED');
    scheduleReconnect(generation);
  });
  setTimeout(() => {
    if (generation !== wsGeneration) return;
    if (!ticks.size) {
      console.log('WS_WATCHDOG_NO_DATA=1');
      reconnects++;
      connectFeed(true);
    }
  }, FEED_TIMEOUT);
}

function connectFeed(forceGlobal = false) {
  const generation = ++wsGeneration;
  closeSocket();
  connected = false;
  feedMode = 'CONNECTING';

  // Prefer the single global USD-M miniTicker stream. It avoids hundreds of
  // individual subscriptions and minimizes client-side subscription traffic.
  const globalUrl = 'wss://fstream.binance.com/ws/!miniTicker@arr';
  const combinedUrl = 'wss://fstream.binance.com/stream?streams=!miniTicker@arr';
  const url = forceGlobal ? globalUrl : globalUrl;
  console.log('WS_CONNECT', url, 'mode=GLOBAL_MINITICKER');
  openWebSocket(url, 'GLOBAL_MINITICKER', generation);
}

function scheduleReconnect(generation) {
  if (generation !== wsGeneration) return;
  setTimeout(() => {
    if (generation !== wsGeneration) return;
    reconnects++;
    connectFeed(true);
  }, 1500);
}

async function boot() {
  try { await universe(); } catch (e) { errors++; console.error('UNIVERSE_ERROR', e.message); }
  srv.listen(PORT, () => console.log('SUPREMO PAPER ENGINE PORT', PORT));
  connectFeed();
  setInterval(() => {
    if (!connected || (lastDataAt && now()-lastDataAt > FEED_TIMEOUT)) {
      console.log('FEED_WATCHDOG reconnect');
      reconnects++;
      connectFeed();
    }
  }, Math.max(2000, Math.floor(FEED_TIMEOUT/2)));
  setInterval(scan, SCAN_MS);
  setInterval(async () => {
    try { await universe(); } catch (e) { errors++; console.error('UNIVERSE_REFRESH_ERROR', e.message); }
  }, 15 * 60 * 1000);
}

boot();
