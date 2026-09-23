const express = require("express");
const app = express();
const PORT = Number(process.env.PORT || 3000);

const CFG = {
  maxPositions: 4,
  positionRiskPct: 0.02,
  minScore: 8,
  cooldownMs: 45 * 60 * 1000,
  maxHoldMs: 45 * 60 * 1000,
  pollMs: 15000,
  symbols: [],
  initialCapital: Number(process.env.INITIAL_CAPITAL || 10000)
};

const state = {
  version: "SUPREMO V12 ADAPTIVE REGIME",
  mode: "PAPER",
  status: "STARTING",
  markets: 0,
  dataMarkets: 0,
  scans: 0,
  equity: CFG.initialCapital,
  realizedPnl: 0,
  floatingPnl: 0,
  cash: CFG.initialCapital,
  positions: {},
  cooldown: {},
  stats: { wins: 0, losses: 0, long: 0, short: 0 },
  candidates: [],
  events: [],
  marketRegimes: {},
  lastScan: null
};

function logEvent(type, symbol, data) {
  state.events.unshift(Object.assign({
    time: new Date().toISOString(), type, symbol: symbol || null
  }, data || {}));
  state.events = state.events.slice(0, 100);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, timeout=10000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(url, { signal:c.signal, headers:{"User-Agent":"SUPREMO-V12"} });
    const text = await r.text();
    if (!r.ok) throw new Error("HTTP " + r.status + " " + text.slice(0,120));
    return JSON.parse(text);
  } finally { clearTimeout(t); }
}

async function binance(path) {
  const urls = ["https://fapi.binance.com"+path, "https://api.binance.com"+path];
  let last;
  for (const u of urls) {
    try { return await fetchJson(u); } catch(e) { last=e; }
  }
  throw last || new Error("Binance unavailable");
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2/(period+1);
  let e = values.slice(0, period).reduce((a,b)=>a+b,0)/period;
  for (let i=period;i<values.length;i++) e = values[i]*k + e*(1-k);
  return e;
}

function atr(klines, period=14) {
  if (klines.length < period+1) return null;
  const tr=[];
  for(let i=1;i<klines.length;i++){
    const h=+klines[i][2], l=+klines[i][3], pc=+klines[i-1][4];
    tr.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
  }
  return tr.slice(-period).reduce((a,b)=>a+b,0)/period;
}

function rsi(closes, period=14) {
  if(closes.length < period+1) return null;
  let g=0,l=0;
  for(let i=1;i<=period;i++){
    const d=closes[i]-closes[i-1];
    if(d>0) g+=d; else l-=d;
  }
  let ag=g/period, al=l/period;
  for(let i=period+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    ag=((period-1)*ag+(d>0?d:0))/period;
    al=((period-1)*al+(d<0?-d:0))/period;
  }
  if(al===0) return 100;
  const rs=ag/al;
  return 100-100/(1+rs);
}

function relativeVolume(klines, n=20) {
  if(klines.length<n+1) return 1;
  const v=klines.slice(-(n+1)).map(k=>+k[5]);
  const avg=v.slice(0,-1).reduce((a,b)=>a+b,0)/n;
  return avg ? v[v.length-1]/avg : 1;
}

function regime(x) {
  const spread=(x.ema20-x.ema50)/x.price;
  const atrPct=x.atr/x.price;
  const slope=(x.ema20-x.ema20Prev)/x.price;

  if(atrPct > 0.035) return "VOLATILE";
  if(spread > 0.003 && slope > 0.0003) return "BULL";
  if(spread < -0.003 && slope < -0.0003) return "BEAR";
  return "RANGE";
}

function scoreSignal(x, side) {
  let score=0;
  const trendUp=x.ema20>x.ema50;
  const trendDown=x.ema20<x.ema50;

  if(side==="LONG"){
    if(trendUp) score+=3;
    if(x.rsi>=45 && x.rsi<=68) score+=2;
    if(x.price>=x.ema20 && x.price<=x.ema20+x.atr*0.8) score+=2;
    if(x.momentum>0) score+=1;
    if(x.relVol>=1.1) score+=1;
    if(x.regime==="BULL") score+=2;
  } else {
    if(trendDown) score+=3;
    if(x.rsi>=32 && x.rsi<=55) score+=2;
    if(x.price<=x.ema20 && x.price>=x.ema20-x.atr*0.8) score+=2;
    if(x.momentum<0) score+=1;
    if(x.relVol>=1.1) score+=1;
    if(x.regime==="BEAR") score+=2;
  }
  return score;
}

async function loadSymbols() {
  const info=await binance("/fapi/v1/exchangeInfo");
  const list=info.symbols.filter(s =>
    s.status==="TRADING" &&
    s.quoteAsset==="USDT" &&
    s.contractType==="PERPETUAL"
  ).map(s=>s.symbol);
  state.markets=list.length;
  return list;
}

async function analyzeSymbol(symbol) {
  const ks=await binance("/fapi/v1/klines?symbol="+symbol+"&interval=1m&limit=80");
  if(!Array.isArray(ks) || ks.length<55) throw new Error("insufficient candles");
  const closed=ks.slice(0,-1);
  const closes=closed.map(k=>+k[4]);
  const price=+closed[closed.length-1][4];
  const e20=ema(closes,20), e50=ema(closes,50);
  const prevCloses=closes.slice(0,-1);
  const e20Prev=ema(prevCloses,20);
  const a=atr(closed,14);
  const r=rsi(closes,14);
  const rv=relativeVolume(closed,20);
  const momentum=closes[closes.length-1]-closes[closes.length-6];

  if(![price,e20,e50,e20Prev,a,r,rv,momentum].every(Number.isFinite)) throw new Error("invalid data");

  const x={symbol,price,ema20:e20,ema50:e50,ema20Prev:e20Prev,atr:a,rsi:r,relVol:rv,momentum};
  x.regime=regime(x);
  x.longScore=scoreSignal(x,"LONG");
  x.shortScore=scoreSignal(x,"SHORT");

  return x;
}

function bestCandidate(list) {
  const candidates=[];
  for(const x of list){
    if(x.regime==="VOLATILE") continue;
    if(state.cooldown[x.symbol] && Date.now()<state.cooldown[x.symbol]) continue;
    if(state.positions[x.symbol]) continue;

    if(x.longScore>=CFG.minScore && x.regime==="BULL") {
      candidates.push({...x, side:"LONG", score:x.longScore});
    }
    if(x.shortScore>=CFG.minScore && x.regime==="BEAR") {
      candidates.push({...x, side:"SHORT", score:x.shortScore});
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  return candidates;
}

function enter(c) {
  if(Object.keys(state.positions).length>=CFG.maxPositions) return false;

  const allocation=Math.min(state.cash,state.equity*CFG.positionRiskPct);
  if(allocation<=0) return false;

  const stopDist=Math.max(c.atr*1.5,c.price*0.006);
  const tpDist=stopDist*1.8;

  state.positions[c.symbol]={
    symbol:c.symbol, side:c.side, entry:c.price, qty:allocation/c.price,
    allocation, stop:c.side==="LONG"?c.price-stopDist:c.price+stopDist,
    tp:c.side==="LONG"?c.price+tpDist:c.price-tpDist,
    openedAt:Date.now(), score:c.score, regime:c.regime
  };
  state.cash-=allocation;
  state.stats[c.side.toLowerCase()]++;
  logEvent("ENTRY",c.symbol,{side:c.side,price:c.price,score:c.score,regime:c.regime});
  return true;
}

function managePosition(p,x) {
  const age=Date.now()-p.openedAt;
  let reason=null;
  if(p.side==="LONG"){
    if(x.price<=p.stop) reason="STOP";
    else if(x.price>=p.tp) reason="TP";
    else if(x.regime==="BEAR" && x.ema20<x.ema50) reason="REGIME_FLIP";
  } else {
    if(x.price>=p.stop) reason="STOP";
    else if(x.price<=p.tp) reason="TP";
    else if(x.regime==="BULL" && x.ema20>x.ema50) reason="REGIME_FLIP";
  }
  if(age>=CFG.maxHoldMs && !reason) reason="TIME";
  if(!reason) return;

  const pnl=p.side==="LONG" ? (x.price-p.entry)*p.qty : (p.entry-x.price)*p.qty;
  state.cash+=p.allocation+pnl;
  state.realizedPnl+=pnl;
  if(pnl>=0) state.stats.wins++; else state.stats.losses++;
  delete state.positions[p.symbol];
  state.cooldown[p.symbol]=Date.now()+CFG.cooldownMs;
  logEvent("EXIT",p.symbol,{side:p.side,reason,entry:p.entry,exit:x.price,pnl});
}

async function scan() {
  state.status="SCANNING";
  let symbols=state.symbolsCache;
  if(!symbols || !symbols.length) {
    symbols=await loadSymbols();
    state.symbolsCache=symbols;
  }

  const results=[];
  for(let i=0;i<symbols.length;i+=20){
    const batch=symbols.slice(i,i+20);
    const out=await Promise.all(batch.map(s=>analyzeSymbol(s).catch(()=>null)));
    for(const x of out) if(x) results.push(x);
    state.dataMarkets=results.length;
  }

  state.candidates=bestCandidate(results).slice(0,12).map(x=>({
    symbol:x.symbol,side:x.side,score:x.score,regime:x.regime,
    price:x.price,rsi:x.rsi,relVol:x.relVol
  }));

  for(const p of Object.values({...state.positions})) {
    const x=results.find(z=>z.symbol===p.symbol);
    if(x) {
      managePosition(p,x);
      state.marketRegimes[p.symbol]=x;
    }
  }

  const current=Object.keys(state.positions).length;
  if(current<CFG.maxPositions && state.candidates.length) {
    enter(state.candidates[0]);
  }

  state.floatingPnl=Object.values(state.positions).reduce((sum,p)=>{
    const x=results.find(z=>z.symbol===p.symbol);
    if(!x) return sum;
    return sum+(p.side==="LONG"?(x.price-p.entry)*p.qty:(p.entry-x.price)*p.qty);
  },0);

  state.equity=state.cash+
    Object.values(state.positions).reduce((s,p)=>s+p.allocation,0)+
    state.floatingPnl;

  state.scans++;
  state.lastScan=new Date().toISOString();
  state.status="PAPER_RUNNING";
}

app.get("/health",(_q,res)=>res.json({ok:true,status:state.status,version:state.version}));
app.get("/status",(_q,res)=>res.json(state));

app.get("/",(_q,res)=>{
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SUPREMO V12 Adaptive Regime</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;background:#080d13;color:#edf2f7;margin:0;padding:18px}
h1{font-size:32px}.card{background:#111a24;border:1px solid #2a3b4e;border-radius:16px;padding:18px;margin:12px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
.big{font-size:28px;font-weight:800}.ok{color:#4ade80}.bad{color:#fb7185}.warn{color:#fbbf24}.muted{color:#94a3b8}
.row{display:flex;justify-content:space-between;margin:8px 0}.candidate{padding:10px;border-top:1px solid #253443}
</style></head><body>
<h1>SUPREMO V12 · ADAPTIVE REGIME</h1>
<div class="card"><b>PAPER · Binance USD-M público · 528 aprox. mercados</b><br>
El motor decide LONG / SHORT / NO TRADE según régimen. No invierte señales automáticamente.<br>
<b>Máximo 4 posiciones · 1 entrada por ciclo · riesgo 2% · cooldown 45 min.</b>
</div>
<div id="app">Cargando…</div>
<script>
function esc(v){return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
async function load(){
 try{
  const s=await (await fetch("/status",{cache:"no-store"})).json();
  let h='<div class="grid">';
  h+='<div class="card"><div class="muted">ESTADO</div><div class="big">'+esc(s.status)+'</div><div>Scan '+s.scans+' · Datos '+s.dataMarkets+'/'+s.markets+'</div></div>';
  h+='<div class="card"><div class="muted">EQUITY</div><div class="big">$'+Number(s.equity).toFixed(2)+'</div><div>PnL realizado: $'+Number(s.realizedPnl).toFixed(2)+' · flotante: $'+Number(s.floatingPnl).toFixed(2)+'</div></div>';
  h+='</div>';
  h+='<div class="card"><h2>Candidatos</h2>';
  if(!s.candidates.length) h+='<p class="warn">NO TRADE · no hay oportunidad con ventaja suficiente</p>';
  s.candidates.forEach(c=>{
    h+='<div class="candidate"><b>'+esc(c.symbol)+'</b> · '+esc(c.side)+' · score '+c.score+' · régimen '+esc(c.regime)+' · RSI '+Number(c.rsi).toFixed(1)+' · RV '+Number(c.relVol).toFixed(2)+'x</div>';
  });
  h+='</div>';
  h+='<div class="card"><h2>Posiciones '+Object.keys(s.positions).length+'/4</h2>';
  const ps=Object.values(s.positions);
  if(!ps.length) h+='<p class="muted">Sin posiciones.</p>';
  ps.forEach(p=>{h+='<div class="candidate"><b>'+esc(p.symbol)+'</b> · '+esc(p.side)+' · entrada '+Number(p.entry).toFixed(4)+' · score '+p.score+' · '+esc(p.regime)+'</div>'});
  h+='</div>';
  h+='<div class="card"><b>Resultados:</b> '+s.stats.wins+' ganadoras · '+s.stats.losses+' perdedoras · LONG '+s.stats.long+' · SHORT '+s.stats.short+'<br><span class="muted">Último scan: '+esc(s.lastScan||"")+'</span></div>';
  document.getElementById("app").innerHTML=h;
 }catch(e){document.getElementById("app").innerHTML='<div class="card bad">'+esc(e.message)+'</div>'}
}
load();setInterval(load,5000);
</script></body></html>`);
});

app.listen(PORT,"0.0.0.0",()=>{
  console.log("SUPREMO V12 ADAPTIVE REGIME listening on "+PORT);
  scan().catch(e=>logEvent("START_SCAN_ERROR",null,{message:e.message}));
  setInterval(()=>scan().catch(e=>logEvent("SCAN_ERROR",null,{message:e.message})),CFG.pollMs);
});
process.on("uncaughtException",e=>console.error("UNCAUGHT_EXCEPTION",e));
process.on("unhandledRejection",e=>console.error("UNHANDLED_REJECTION",e));
