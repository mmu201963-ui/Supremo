import express from "express";

const app = express();
const PORT = Number(process.env.PORT || 3000);

const CFG = {
  symbols: ["BTCUSDT", "ETHUSDT"],
  interval: "4h",
  klines: 120,
  rsiPeriod: 14,
  bbPeriod: 20,
  bbStd: 2,
  initialCapital: Number(process.env.INITIAL_CAPITAL || 10000),
  positionPct: Math.min(Number(process.env.POSITION_PCT || 0.05), 0.05),
  stopPct: Number(process.env.STOP_PCT || 0.04),
  pollMs: Number(process.env.POLL_MS || 30000)
};

const state = {
  startedAt: new Date().toISOString(),
  equity: CFG.initialCapital,
  cash: CFG.initialCapital,
  realizedPnl: 0,
  positions: {},
  lastScan: null,
  scans: 0,
  events: []
};

function sma(values, period) {
  if (values.length < period) return null;
  const s = values.slice(-period);
  return s.reduce((a, b) => a + b, 0) / period;
}

function stddev(values, period) {
  if (values.length < period) return null;
  const s = values.slice(-period);
  const mean = s.reduce((a, b) => a + b, 0) / period;
  return Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
}

function rsi(closes, period) {
  if (closes.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

async function getKlines(symbol) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${CFG.interval}&limit=${CFG.klines}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
  return await r.json();
}

function indicators(klines) {
  // Use the last CLOSED candle: the final Binance kline can still be forming.
  const closed = klines.slice(0, -1);
  const closes = closed.map(k => Number(k[4]));
  const price = Number(closed.at(-1)[4]);
  const mid = sma(closes, CFG.bbPeriod);
  const sd = stddev(closes, CFG.bbPeriod);
  const lower = mid - CFG.bbStd * sd;
  const upper = mid + CFG.bbStd * sd;
  const r = rsi(closes, CFG.rsiPeriod);
  return { price, rsi: r, upper, middle: mid, lower, candleTime: new Date(Number(closed.at(-1)[6])).toISOString() };
}

function signalFor(x, position) {
  if (position) {
    if (x.rsi > 60 || x.price >= x.middle) return "SELL";
    if (x.price <= position.stop) return "STOP";
    return "HOLD";
  }
  if (x.rsi < 30 && x.price <= x.lower) return "BUY";
  return "WAIT";
}

function logEvent(type, symbol, data) {
  state.events.unshift({ time: new Date().toISOString(), type, symbol, ...data });
  state.events = state.events.slice(0, 100);
}

async function scan() {
  const snapshot = {};
  for (const symbol of CFG.symbols) {
    try {
      const k = await getKlines(symbol);
      const x = indicators(k);
      const pos = state.positions[symbol];
      const signal = signalFor(x, pos);

      if (!pos && signal === "BUY") {
        const allocation = Math.min(state.cash, state.equity * CFG.positionPct);
        if (allocation > 0) {
          const qty = allocation / x.price;
          const stop = x.price * (1 - CFG.stopPct);
          state.positions[symbol] = {
            symbol,
            entry: x.price,
            qty,
            allocation,
            stop,
            enteredAt: new Date().toISOString(),
            entryRsi: x.rsi
          };
          state.cash -= allocation;
          logEvent("ENTRY", symbol, {
            price: x.price, rsi: x.rsi, lower: x.lower, middle: x.middle,
            stop, allocation
          });
        }
      } else if (pos && (signal === "SELL" || signal === "STOP")) {
        const exit = x.price;
        const pnl = (exit - pos.entry) * pos.qty;
        state.cash += pos.allocation + pnl;
        state.realizedPnl += pnl;
        logEvent(signal === "STOP" ? "STOP" : "EXIT", symbol, {
          entry: pos.entry, exit, pnl, rsi: x.rsi, middle: x.middle
        });
        delete state.positions[symbol];
      }

      snapshot[symbol] = { ...x, signal, position: state.positions[symbol] || null };
    } catch (e) {
      snapshot[symbol] = { error: e.message };
      logEvent("ERROR", symbol, { message: e.message });
    }
  }

  let floating = 0;
  for (const [symbol, pos] of Object.entries(state.positions)) {
    const s = snapshot[symbol];
    if (s?.price) floating += (s.price - pos.entry) * pos.qty;
  }
  state.equity = state.cash + Object.values(state.positions).reduce((a, p) => a + p.allocation, 0) + floating;
  state.lastScan = new Date().toISOString();
  state.scans++;
  state.market = snapshot;
}

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SUPREMO · Mean Reversion 4H</title>
<style>
body{font-family:Arial,sans-serif;background:#0b1017;color:#e8eef7;margin:0;padding:24px}
.card{background:#111923;border:1px solid #263342;border-radius:14px;padding:18px;margin:12px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
.good{color:#4ade80}.warn{color:#fbbf24}.bad{color:#fb7185}
small{color:#94a3b8}pre{white-space:pre-wrap;overflow:auto}
</style></head><body>
<h1>SUPREMO · Mean Reversion 4H</h1>
<div class="card"><b>PAPER ONLY</b> · BTCUSDT / ETHUSDT · 4H · RSI(14) · Bollinger(20,2)</div>
<div id="app">Cargando…</div>
<script>
async function load(){
 const r=await fetch('/status'); const s=await r.json();
 let h='<div class="grid">';
 for(const [sym,x] of Object.entries(s.market||{})){
   if(x.error){h+=`<div class="card"><h2>${sym}</h2><p class="bad">${x.error}</p></div>`;continue;}
   const sig=x.signal;
   h+=`<div class="card"><h2>${sym}</h2>
   <p><b>Precio:</b> ${x.price.toFixed(2)}</p>
   <p><b>RSI(14):</b> ${x.rsi.toFixed(2)}</p>
   <p><b>BB superior:</b> ${x.upper.toFixed(2)}</p>
   <p><b>BB media:</b> ${x.middle.toFixed(2)}</p>
   <p><b>BB inferior:</b> ${x.lower.toFixed(2)}</p>
   <p><b>Señal:</b> <span class="${sig==='BUY'?'good':sig==='SELL'||sig==='STOP'?'bad':'warn'}">${sig}</span></p>
   <p><small>Última vela cerrada: ${x.candleTime}</small></p>
   ${x.position?`<p>Entrada ${x.position.entry.toFixed(2)} · Stop ${x.position.stop.toFixed(2)}</p>`:''}
   </div>`;
 }
 h+='</div>';
 h+=`<div class="card"><b>Equity:</b> ${s.equity.toFixed(2)} · <b>Realizado:</b> ${s.realizedPnl.toFixed(2)} · <b>Cash:</b> ${s.cash.toFixed(2)}<br><small>Scans: ${s.scans} · ${s.lastScan||''}</small></div>`;
 h+=`<div class="card"><h3>Eventos recientes</h3><pre>${JSON.stringify(s.events.slice(0,20),null,2)}</pre></div>`;
 document.getElementById('app').innerHTML=h;
}
load(); setInterval(load,5000);
</script></body></html>`);
});

app.get("/status", (_req, res) => res.json(state));

app.listen(PORT, () => {
  console.log(`SUPREMO Mean Reversion 4H PAPER listening on ${PORT}`);
  scan();
  setInterval(scan, CFG.pollMs);
});
