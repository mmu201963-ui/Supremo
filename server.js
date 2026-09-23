const express = require("express");
const app = express();
const PORT = Number(process.env.PORT || 3000);

const CFG = {
  symbols: ["BTCUSDT", "ETHUSDT"],
  interval: "4h",
  limit: 150,
  rsiPeriod: 14,
  bbPeriod: 20,
  bbStd: 2,
  sellRsi: Number(process.env.SELL_RSI || 60),
  initialCapital: Number(process.env.INITIAL_CAPITAL || 10000),
  positionPct: Math.min(Math.max(Number(process.env.POSITION_PCT || 0.05), 0), 0.05),
  stopPct: Math.min(Math.max(Number(process.env.STOP_PCT || 0.04), 0.03), 0.05),
  pollMs: Math.max(Number(process.env.POLL_MS || 30000), 10000),
  timeoutMs: 10000
};

const state = {
  status: "STARTING",
  startedAt: new Date().toISOString(),
  lastScan: null,
  scans: 0,
  equity: CFG.initialCapital,
  cash: CFG.initialCapital,
  realizedPnl: 0,
  floatingPnl: 0,
  positions: {},
  market: {},
  events: []
};

function addEvent(type, symbol, data) {
  state.events.unshift(Object.assign({
    time: new Date().toISOString(),
    type: type,
    symbol: symbol || null
  }, data || {}));
  state.events = state.events.slice(0, 100);
}

function sma(values, period) {
  if (values.length < period) return null;
  var a = values.slice(-period);
  return a.reduce(function(s, v) { return s + v; }, 0) / period;
}

function stdev(values, period) {
  if (values.length < period) return null;
  var a = values.slice(-period);
  var m = sma(values, period);
  return Math.sqrt(a.reduce(function(s, v) {
    return s + Math.pow(v - m, 2);
  }, 0) / period);
}

// Wilder RSI
function wilderRsi(closes, period) {
  if (closes.length < period + 1) return null;

  var gain = 0, loss = 0;
  for (var i = 1; i <= period; i++) {
    var d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }

  var avgGain = gain / period;
  var avgLoss = loss / period;

  for (var j = period + 1; j < closes.length; j++) {
    var diff = closes[j] - closes[j - 1];
    var g = diff > 0 ? diff : 0;
    var l = diff < 0 ? -diff : 0;
    avgGain = ((avgGain * (period - 1)) + g) / period;
    avgLoss = ((avgLoss * (period - 1)) + l) / period;
  }

  if (avgLoss === 0) return 100;
  var rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

async function fetchJson(url) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, CFG.timeoutMs);

  try {
    var r = await fetch(url, {
      headers: { "User-Agent": "SUPREMO-MeanReversion/1.3.1" },
      signal: controller.signal
    });
    var body = await r.text();
    if (!r.ok) throw new Error("HTTP " + r.status + ": " + body.slice(0, 160));
    return JSON.parse(body);
  } finally {
    clearTimeout(timer);
  }
}

async function binance(path) {
  var urls = [
    "https://fapi.binance.com" + path,
    "https://api.binance.com" + path
  ];
  var last = null;

  for (var i = 0; i < urls.length; i++) {
    try {
      return await fetchJson(urls[i]);
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error("Binance unavailable");
}

async function getData(symbol) {
  var klines = await binance(
    "/fapi/v1/klines?symbol=" + symbol +
    "&interval=4h&limit=" + CFG.limit
  );

  if (!Array.isArray(klines) ||
      klines.length < CFG.bbPeriod + CFG.rsiPeriod + 3) {
    throw new Error("Insufficient candles");
  }

  // Indicators from the last CLOSED 4H candle.
  var closed = klines.slice(0, -1);
  var closes = closed.map(function(k) { return Number(k[4]); });

  var middle = sma(closes, CFG.bbPeriod);
  var sd = stdev(closes, CFG.bbPeriod);
  var lower = middle - CFG.bbStd * sd;
  var upper = middle + CFG.bbStd * sd;
  var rsi = wilderRsi(closes, CFG.rsiPeriod);

  // Current market price, separate from the closed-candle indicators.
  var ticker = await binance("/fapi/v1/ticker/price?symbol=" + symbol);
  var price = Number(ticker.price);

  if (![price, middle, lower, upper, rsi].every(Number.isFinite)) {
    throw new Error("Invalid indicator data");
  }

  return {
    price: price,
    rsi: rsi,
    upper: upper,
    middle: middle,
    lower: lower,
    distanceLowerPct: ((price / lower) - 1) * 100,
    distanceMiddlePct: ((price / middle) - 1) * 100,
    candleTime: new Date(Number(closed[closed.length - 1][6])).toISOString()
  };
}

function getSignal(x, position) {
  var buy = x.rsi < 30 && x.price <= x.lower;
  var sell = x.rsi > CFG.sellRsi || x.price >= x.middle;

  if (position) {
    if (sell) return "SELL";
    if (x.price <= position.stop) return "STOP";
    return "HOLD";
  }

  if (buy) return "BUY";
  if (sell) return "OVERBOUGHT";
  return "WAIT";
}

async function scan() {
  state.status = "SCANNING";

  for (var i = 0; i < CFG.symbols.length; i++) {
    var symbol = CFG.symbols[i];

    try {
      var x = await getData(symbol);
      var position = state.positions[symbol];
      var signal = getSignal(x, position);

      if (!position && signal === "BUY") {
        var allocation = Math.min(
          state.cash,
          state.equity * CFG.positionPct
        );

        if (allocation > 0) {
          var qty = allocation / x.price;
          var stop = x.price * (1 - CFG.stopPct);

          state.positions[symbol] = {
            symbol: symbol,
            entry: x.price,
            qty: qty,
            allocation: allocation,
            stop: stop,
            enteredAt: new Date().toISOString(),
            entryRsi: x.rsi
          };

          state.cash -= allocation;

          addEvent("PAPER_ENTRY", symbol, {
            price: x.price,
            rsi: x.rsi,
            lower: x.lower,
            middle: x.middle,
            allocation: allocation,
            stop: stop
          });
        }
      } else if (position && (signal === "SELL" || signal === "STOP")) {
        var exit = x.price;
        var pnl = (exit - position.entry) * position.qty;

        state.cash += position.allocation + pnl;
        state.realizedPnl += pnl;

        addEvent(
          signal === "STOP" ? "PAPER_STOP" : "PAPER_EXIT",
          symbol,
          {
            entry: position.entry,
            exit: exit,
            pnl: pnl,
            rsi: x.rsi,
            middle: x.middle
          }
        );

        delete state.positions[symbol];
      }

      state.market[symbol] = Object.assign({}, x, {
        signal: signal,
        position: state.positions[symbol] || null
      });
    } catch (e) {
      state.market[symbol] = {
        error: e.message,
        signal: "ERROR"
      };
      addEvent("DATA_ERROR", symbol, { message: e.message });
    }
  }

  state.floatingPnl = Object.keys(state.positions).reduce(function(sum, symbol) {
    var p = state.positions[symbol];
    var m = state.market[symbol];
    if (!m || !Number.isFinite(m.price)) return sum;
    return sum + ((m.price - p.entry) * p.qty);
  }, 0);

  state.equity =
    state.cash +
    Object.keys(state.positions).reduce(function(sum, symbol) {
      return sum + state.positions[symbol].allocation;
    }, 0) +
    state.floatingPnl;

  state.scans += 1;
  state.lastScan = new Date().toISOString();
  state.status = "PAPER_RUNNING";
}

app.get("/health", function(_req, res) {
  res.status(200).json({
    ok: true,
    status: state.status,
    uptimeSec: Math.round(process.uptime())
  });
});

app.get("/status", function(_req, res) {
  res.status(200).json(state);
});

app.get("/", function(_req, res) {
  res.sendFile(__dirname + "/index.html");
});

app.listen(PORT, "0.0.0.0", function() {
  console.log("SUPREMO Mean Reversion V3.1 listening on " + PORT);
  scan().catch(function(e) {
    addEvent("SCAN_ERROR", null, { message: e.message });
  });
  setInterval(function() {
    scan().catch(function(e) {
      addEvent("SCAN_ERROR", null, { message: e.message });
    });
  }, CFG.pollMs);
});

process.on("uncaughtException", function(e) {
  console.error("UNCAUGHT_EXCEPTION", e);
});
process.on("unhandledRejection", function(e) {
  console.error("UNHANDLED_REJECTION", e);
});
