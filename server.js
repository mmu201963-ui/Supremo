const http = require('http');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 3000);
const START = Number(process.env.PAPER_START_CAPITAL || 10000);
const FEE = Number(process.env.FEE_RATE || 0.0004);
const SLIP = Number(process.env.SLIPPAGE_RATE || 0.0002);
const MAX_POS = Number(process.env.MAX_POSITIONS || 12);
const MAX_SIDE = Number(process.env.MAX_SIDE || 6);
const MARGIN = Number(process.env.POSITION_MARGIN || 100);
const LEV = Number(process.env.LEVERAGE || 5);
const TP = Number(process.env.PAPER_TP || 0.006);
const SL = Number(process.env.PAPER_SL || 0.004);
const HOLD = Number(process.env.PAPER_MAX_HOLD_MS || 900000);
const FEED_TIMEOUT = Number(process.env.FEED_TIMEOUT_MS || 8000);
const CANDLE_MS = 30000; // 30-second candle: the only entry signal.

const now = () => Date.now();

let symbols = new Map();
let ticks = new Map();
let candles = new Map();
let closedCandles = new Map();
let lastSignalCandle = new Map();
let lastClosedCandle = new Map();
let lastEntryCandle = new Map();
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
let errors = 0;
let reconnects = 0;
let ws = null;
let wsGeneration = 0;
let universeLoadedAt = 0;
let universeSource = 'NONE';
let firstDataAt = 0;
let dataMessages = 0;
let dataUpdates = 0;
let symbolsUpdatedThisCycle = 0;
let peakEquity = START;
let maxDrawdown = 0;
let entries = 0;

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'SUPREMO/6.0' } });
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
}

function updateCandle(s, price, ts) {
  const bucket = Math.floor(ts / CANDLE_MS) * CANDLE_MS;
  let c = candles.get(s);
  if (!c) {
    candles.set(s, { start: bucket, open: price, high: price, low: price, close: price, ticks: 1 });
    return;
  }
  if (c.start === bucket) {
    c.high = Math.max(c.high, price);
    c.low = Math.min(c.low, price);
    c.close = price;
    c.ticks++;
    return;
  }
  if (c.start < bucket) {
    let arr = closedCandles.get(s) || [];
    arr.push({ ...c });
    if (arr.length > 4) arr = arr.slice(-4);
    closedCandles.set(s, arr);
    candles.set(s, { start: bucket, open: price, high: price, low: price, close: price, ticks: 1 });
  }
}

function tick(s, p, v, ts) {
  if (!(p > 0)) return;
  if (!symbols.has(s) && s.endsWith('USDT')) {
    symbols.set(s, { symbol:s, status:'TRADING', quoteAsset:'USDT', contractType:'PERPETUAL' });
    if (!universeLoadedAt) universeLoadedAt = now();
    if (universeSource === 'NONE') universeSource = 'LIVE_STREAM_DISCOVERY';
  }
  if (!symbols.has(s)) return;
  ticks.set(s, { price:p, volume:v, ts });
  updateCandle(s, p, ts);
  dataUpdates++;
  lastDataAt = ts;
  if (!firstDataAt) firstDataAt = ts;
}

function candleDirection(c) {
  if (!c || c.ticks < 2 || c.close === c.open) return null;
  return c.close > c.open ? 'LONG' : 'SHORT';
}

function candleSignal(s) {
  const arr = closedCandles.get(s);
  if (!arr || arr.length < 2) return null;
  const a = arr[arr.length - 2];
  const b = arr[arr.length - 1];
  const da = candleDirection(a);
  const db = candleDirection(b);
  if (!da || da !== db) return null;
  if (lastSignalCandle.get(s) === b.start) return null;
  lastSignalCandle.set(s, b.start);
  return { symbol:s, side:db, candleStart:b.start, first:a, second:b, bodyPct:(b.close/b.open-1)*100, ticks:b.ticks, reason:'TWO_CONSECUTIVE_CLOSED_CANDLES' };
}

function counts() {
  let l=0,s=0;
  for (const p of pos.values()) p.side === 'LONG' ? l++ : s++;
  return {l,s};
}

function feedHealthy() {
  return connected && ticks.size > 0 && lastDataAt > 0 && now() - lastDataAt < FEED_TIMEOUT;
}

function openPosition(signal, price) {
  if (pos.has(signal.symbol) || pos.size >= MAX_POS) return false;
  const c = counts();
  if (signal.side === 'LONG' && c.l >= MAX_SIDE) return false;
  if (signal.side === 'SHORT' && c.s >= MAX_SIDE) return false;
  if (lastEntryCandle.get(signal.symbol) === signal.candleStart) return false;

  pos.set(signal.symbol, {
    symbol:signal.symbol,
    side:signal.side,
    entry:price,
    openedAt:now(),
    margin:MARGIN,
    candleStart:signal.candleStart,
    signalBodyPct:signal.bodyPct,
    reason:signal.reason
  });
  lastEntryCandle.set(signal.symbol, signal.candleStart);
  entries++;
  return true;
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
  trades.push({ symbol:p.symbol, side:p.side, entry:p.entry, exit:price, net, reason, heldMs:now()-p.openedAt, candleStart:p.candleStart });
  if (trades.length > 1000) trades.shift();
  pos.delete(p.symbol);
}

function oppositeClosedCandle(s, side, afterStart) {
  const arr = closedCandles.get(s);
  if (!arr || !arr.length) return false;
  const c = arr[arr.length - 1];
  if (c.start <= afterStart) return false;
  const d = candleDirection(c);
  return d && d !== side;
}

function manage() {
  for (const p of [...pos.values()]) {
    const t = ticks.get(p.symbol);
    if (!t) continue;
    const d = p.side === 'LONG' ? 1 : -1;
    const move = (t.price / p.entry - 1) * d;
    if (move >= TP) closePosition(p, t.price, 'TP');
    else if (move <= -SL) closePosition(p, t.price, 'SL');
    else if (oppositeClosedCandle(p.symbol, p.side, p.candleStart)) closePosition(p, t.price, 'OPPOSITE_CLOSED_CANDLE');
    else if (now() - p.openedAt >= HOLD) closePosition(p, t.price, 'TIME');
  }
}

function scan() {
  const st = performance.now();
  scanNo++;
  manage();
  let updated=0;
  for (const s of symbols.keys()) if (ticks.has(s)) updated++;
  symbolsUpdatedThisCycle=updated;

  if (feedHealthy()) {
    // ENTRY RULE: candle structure only. Require TWO consecutive CLOSED
    // 30-second candles in the same direction. Two green = LONG; two red = SHORT.
    // No score, RSI, momentum, edge, volume or external indicators.
    // Do not fill all 12 slots automatically.
    for (const s of symbols.keys()) {
      if (pos.size >= MAX_POS) break;
      const t = ticks.get(s);
      if (!t) continue;
      const signal = candleSignal(s);
      if (signal) openPosition(signal, t.price);
    }
  }
  lastScanMs = performance.now() - st;
}

function positionSnapshot() {
  const rows = [];
  for (const p of pos.values()) {
    const t = ticks.get(p.symbol);
    if (!t) continue;
    const d = p.side === 'LONG' ? 1 : -1;
    const move = (t.price / p.entry - 1) * d;
    const gross = p.margin * move * LEV;
    const fees = p.margin * LEV * FEE * 2;
    const slip = p.margin * LEV * SLIP * 2;
    const net = gross - fees - slip;
    rows.push({symbol:p.symbol,side:p.side,entry:p.entry,price:t.price,movePct:move*100,gross,fees,slip,net,openedAt:p.openedAt,ageMs:now()-p.openedAt,candleStart:p.candleStart,reason:p.reason});
  }
  return rows;
}

function state() {
  const livePositions = positionSnapshot();
  const unrealized = livePositions.reduce((a,p)=>a+p.net,0);
  const totalPnl = realized + unrealized;
  const liveEquity = START + totalPnl;
  peakEquity = Math.max(peakEquity, liveEquity);
  maxDrawdown = Math.max(maxDrawdown, peakEquity - liveEquity);
  const winners = livePositions.filter(p=>p.net>0).length;
  const losers = livePositions.filter(p=>p.net<0).length;
  const coverage=symbols.size?ticks.size/symbols.size:0;
  const candleRows=[];
  for (const [s,c] of candles) {
    if (c.ticks < 2 || c.close===c.open) continue;
    candleRows.push({symbol:s,side:c.close>c.open?'LONG':'SHORT',bodyPct:(c.close/c.open-1)*100,open:c.open,close:c.close,ticks:c.ticks});
  }
  candleRows.sort((a,b)=>Math.abs(b.bodyPct)-Math.abs(a.bodyPct));
  return {
    name:'SUPREMO',version:'11.0',mode:'PAPER',entryRule:'TWO_CONSECUTIVE_CLOSED_30S_CANDLES',markets:symbols.size,ticks:ticks.size,
    coverage:+coverage.toFixed(4),coveragePct:+(coverage*100).toFixed(1),scanNo,lastScanMs:+lastScanMs.toFixed(3),connected,feedMode,
    feedHealthy:feedHealthy(),feedAgeMs:lastDataAt?now()-lastDataAt:null,dataMessages,dataUpdates,symbolsUpdatedThisCycle,
    equity:+liveEquity.toFixed(2),realized:+realized.toFixed(2),unrealized:+unrealized.toFixed(2),totalPnl:+totalPnl.toFixed(2),
    positions:livePositions,trades:trades.slice(-50).reverse(),candleSignals:candleRows.slice(0,40),entries,errors,reconnects,
    winners,losers,maxDrawdown:+maxDrawdown.toFixed(2),universeSource,universeLoadedAt,firstDataAt
  };
}

const page=`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SUPREMO V10 — Real-Time PnL PAPER</title><style>body{font-family:Arial;background:#070b11;color:#eaf0f8;padding:18px;margin:0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px}.c,.p{background:#111a25;border:1px solid #263448;border-radius:12px;padding:14px;margin-bottom:12px}.b{font-size:24px;font-weight:bold;margin-top:4px}.m{color:#92a1b6;font-size:12px;line-height:1.5}.ok{color:#55e6a5}.bad{color:#ff7184}.warn{color:#ffd166}table{width:100%;border-collapse:collapse;font-size:12px}td,th{padding:7px;border-bottom:1px solid #223044;text-align:right}td:first-child,th:first-child{text-align:left}.scroll{overflow:auto;max-height:430px}</style></head><body><h2>SUPREMO V11 — CANDLE STRUCTURE · CLOSED 30s</h2><div class=m>Binance USD-M público · PAPER · sin API keys · sin órdenes reales</div><div id=status class="p warn">Inicializando feed...</div><div class=grid><div class=c>Mercados<div id=m class=b>—</div></div><div class=c>Datos<div id=t class=b>—</div><div id=cov class=m>—</div></div><div class=c>Scan #<div id=n class=b>—</div></div><div class=c>Equity total<div id=e class=b>—</div></div><div class=c>PnL TOTAL<div id=p class=b>—</div></div><div class=c>Realizado<div id=pr class=b>—</div></div><div class=c>Flotante neto<div id=pu class=b>—</div></div><div class=c>Posiciones<div id=o class=b>—</div><div id=wl class=m>—</div></div><div class=c>Entradas<div id=en class=b>—</div></div><div class=c>Feed<div id=w class=b>—</div></div></div><div class=p><b>REGLA DE ENTRADA V11</b><div class=m><b>Solo estructura de velas.</b> Requiere DOS velas cerradas consecutivas de 30 segundos en la misma dirección. Dos verdes = LONG. Dos rojas = SHORT. Se entra al comenzar la siguiente vela. Sin RSI, MACD, momentum, score, volumen ni IA. No se llenan las 12 plazas por obligación.</div></div><div class=p><b>REGLA DE SALIDA</b><div class=m>TP/SL de seguridad + salida si aparece una vela cerrada contraria posterior a la señal + tiempo máximo. PnL incluye comisión y slippage estimados.</div></div><div class=p><b>POSICIONES EN TIEMPO REAL</b><div class=scroll><table><thead><tr><th>PAR</th><th>LADO</th><th>ENTRADA</th><th>PRECIO</th><th>MOV %</th><th>PNL NETO</th><th>EDAD</th></tr></thead><tbody id=op></tbody></table></div></div><div class=p><b>VELAS ACTIVAS</b><div class=scroll><table><thead><tr><th>PAR</th><th>LADO</th><th>CUERPO %</th><th>OPEN</th><th>CLOSE</th><th>TICKS</th></tr></thead><tbody id=s></tbody></table></div></div><div class=p><b>TRADES PAPER CERRADOS</b><div class=scroll><table><thead><tr><th>PAR</th><th>LADO</th><th>NETO</th><th>MOTIVO</th><th>TIEMPO</th></tr></thead><tbody id=r></tbody></table></div></div><div class=p><b>DIAGNÓSTICO</b><div id=d class=m>—</div></div><script>const $=id=>document.getElementById(id);const money=v=>'$'+Number(v).toFixed(2);async function u(){try{const x=await fetch('/api/state',{cache:'no-store'}).then(r=>r.json());$('m').textContent=x.markets;$('t').textContent=x.ticks;$('cov').textContent=x.coveragePct+'% cobertura real';$('n').textContent=x.scanNo;$('e').textContent=money(x.equity);$('p').textContent=money(x.totalPnl);$('p').className='b '+(x.totalPnl>=0?'ok':'bad');$('pr').textContent=money(x.realized);$('pr').className='b '+(x.realized>=0?'ok':'bad');$('pu').textContent=money(x.unrealized);$('pu').className='b '+(x.unrealized>=0?'ok':'bad');$('o').textContent=x.positions.length;$('wl').textContent='ganadoras '+x.winners+' · perdedoras '+x.losers;$('en').textContent=x.entries;$('w').textContent=x.feedHealthy?'OK':'WAIT';$('w').className='b '+(x.feedHealthy?'ok':'bad');$('status').className='p '+(x.feedHealthy?'ok':'warn');$('status').textContent=x.feedHealthy?('FEED OK · '+x.ticks+'/'+x.markets+' mercados con datos · '+x.feedMode):('ESPERANDO FEED · WS '+(x.connected?'conectado':'desconectado')+' · datos '+x.ticks+'/'+x.markets);$('op').innerHTML=x.positions.map(a=>'<tr><td>'+a.symbol+'</td><td class='+(a.side==='LONG'?'ok':'bad')+'>'+a.side+'</td><td>'+a.entry+'</td><td>'+a.price+'</td><td class='+(a.movePct>=0?'ok':'bad')+'>'+a.movePct.toFixed(4)+'</td><td class='+(a.net>=0?'ok':'bad')+'>'+a.net.toFixed(2)+'</td><td>'+Math.round(a.ageMs/1000)+'s</td></tr>').join('');$('s').innerHTML=x.candleSignals.map(a=>'<tr><td>'+a.symbol+'</td><td class='+(a.side==='LONG'?'ok':'bad')+'>'+a.side+'</td><td>'+a.bodyPct.toFixed(4)+'</td><td>'+a.open+'</td><td>'+a.close+'</td><td>'+a.ticks+'</td></tr>').join('');$('r').innerHTML=x.trades.map(a=>'<tr><td>'+a.symbol+'</td><td>'+a.side+'</td><td class='+(a.net>=0?'ok':'bad')+'>'+a.net.toFixed(2)+'</td><td>'+a.reason+'</td><td>'+Math.round(a.heldMs/1000)+'s</td></tr>').join('');$('d').textContent='updates='+x.dataUpdates+' · actualizados/ciclo='+x.symbolsUpdatedThisCycle+' · edad feed='+(x.feedAgeMs??'-')+'ms · reconexiones='+x.reconnects+' · errores='+x.errors+' · fuente='+x.universeSource+' · drawdown máx='+money(x.maxDrawdown)}catch(e){$('status').textContent='ERROR UI: '+e.message}}setInterval(u,500);u()</script></body></html>`;
const srv=http.createServer((q,r)=>{if(q.url==='/api/state'){r.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return r.end(JSON.stringify(state()));}r.writeHead(200,{'content-type':'text/html;charset=utf-8','cache-control':'no-store'});r.end(page);});

function parseMessage(raw){
  let a;try{a=JSON.parse(raw);}catch{errors++;return;}
  lastMessageAt=now();dataMessages++;
  const payload=a&&a.data!==undefined?a.data:a;
  const arr=Array.isArray(payload)?payload:[payload];
  for(const x of arr){if(x&&x.s&&x.c)tick(String(x.s).toUpperCase(),Number(x.c),Number(x.q||0),Number(x.E||now()));}
  if(arr.length)feedSince=feedSince||now();
}

async function restPriceFallback(){
  try{const d=await getJSON('https://fapi.binance.com/fapi/v1/ticker/price');const ts=now();let n=0;for(const x of d||[]){if(!x||!x.symbol||!x.price)continue;const sym=String(x.symbol).toUpperCase();if(symbols.has(sym)){tick(sym,Number(x.price),0,ts);n++;}}if(n)feedSince=feedSince||ts;}
  catch(e){errors++;console.error('REST_FALLBACK_ERROR',e.message);}
}

function closeSocket(){
  if(!ws) return;
  const old=ws;
  ws=null;
  try{
    // Never remove the error handler before terminating: ws can emit a
    // late 'error' event during terminate(), which would crash Node.
    old.on('error',()=>{});
    old.terminate();
  }catch{}
}
function scheduleReconnect(gen){if(gen!==wsGeneration)return;setTimeout(()=>{if(gen!==wsGeneration)return;reconnects++;connectFeed();},1500);}
function connectFeed(){const gen=++wsGeneration;closeSocket();connected=false;feedMode='CONNECTING';const url='wss://fstream.binance.com/ws/!miniTicker@arr';try{ws=new WebSocket(url);}catch(e){errors++;scheduleReconnect(gen);return;}ws.on('open',()=>{if(gen!==wsGeneration)return;connected=true;feedMode='GLOBAL_MINITICKER';feedSince=now();});ws.on('message',raw=>{if(gen===wsGeneration)parseMessage(raw);});ws.on('error',e=>{errors++;console.error('WS_ERROR',e.message);});ws.on('close',()=>{if(gen!==wsGeneration)return;connected=false;feedMode='RECONNECTING';scheduleReconnect(gen);});}

async function boot(){try{await universe();}catch(e){errors++;console.error('UNIVERSE_ERROR',e.message);}srv.listen(PORT,()=>console.log('SUPREMO V8 PORT',PORT));connectFeed();setInterval(()=>{if(!connected||(lastDataAt&&now()-lastDataAt>FEED_TIMEOUT)){reconnects++;connectFeed();}},4000);setInterval(scan,250);setInterval(()=>{if(!lastDataAt||now()-lastDataAt>2500)restPriceFallback();},1000);setInterval(async()=>{try{await universe();}catch(e){errors++;}},15*60*1000);}
boot();
