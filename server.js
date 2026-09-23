const express = require("express");

const app = express();
const PORT = Number(process.env.PORT || 3000);

const CFG = {
  symbols: ["BTCUSDT", "ETHUSDT"],
  interval: "4h",
  limit: 120,
  rsiPeriod: 14,
  bbPeriod: 20,
  bbStd: 2,
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
  return a.reduce(function(sum, x) { return sum + x; }, 0) / period;
}

function stddev(values, period) {
  if (values.length < period) return null;
  var a = values.slice(-period);
  var mean = a.reduce(function(sum, x) { return sum + x; }, 0) / period;
  var variance = a.reduce(function(sum, x) {
    return sum + Math.pow(x - mean, 2);
  }, 0) / period;
  return Math.sqrt(variance);
}

function calcRsi(closes, period) {
  if (closes.length <= period) return null;
  var gain = 0;
  var loss = 0;

  for (var i = closes.length - period; i < closes.length; i++) {
    var d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }

  if (loss === 0) return 100;
  var rs = (gain / period) / (loss / period);
  return 100 - (100 / (1 + rs));
}

function fetchJson(url) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, CFG.timeoutMs);

  return fetch(url, {
    headers: { "User-Agent": "SUPREMO-MeanReversion/1.2" },
    signal: controller.signal
  })
  .then(function(response) {
    return response.text().then(function(body) {
      if (!response.ok) {
        throw new Error("HTTP " + response.status + ": " + body.slice(0, 180));
      }
      return JSON.parse(body);
    });
  })
  .finally(function() {
    clearTimeout(timer);
  });
}

function getKlines(symbol) {
  var urls = [
    "https://fapi.binance.com/fapi/v1/klines?symbol=" + symbol + "&interval=" + CFG.interval + "&limit=" + CFG.limit,
    "https://api.binance.com/api/v3/klines?symbol=" + symbol + "&interval=" + CFG.interval + "&limit=" + CFG.limit
  ];

  var lastError = null;

  function tryNext(index) {
    if (index >= urls.length) {
      return Promise.reject(lastError || new Error("No se pudo obtener Binance"));
    }
    return fetchJson(urls[index]).then(function(data) {
      if (!Array.isArray(data) || data.length < CFG.bbPeriod + CFG.rsiPeriod + 2) {
        throw new Error("Binance devolvió datos insuficientes");
      }
      return data;
    }).catch(function(error) {
      lastError = error;
      return tryNext(index + 1);
    });
  }

  return tryNext(0);
}

function getIndicators(klines) {
  var closed = klines.slice(0, -1);
  if (closed.length < CFG.bbPeriod + CFG.rsiPeriod) {
    throw new Error("No hay suficientes velas cerradas");
  }

  var closes = closed.map(function(k) { return Number(k[4]); });
  var price = closes[closes.length - 1];
  var middle = sma(closes, CFG.bbPeriod);
  var sd = stddev(closes, CFG.bbPeriod);
  var lower = middle - CFG.bbStd * sd;
  var upper = middle + CFG.bbStd * sd;
  var rsi = calcRsi(closes, CFG.rsiPeriod);

  if (![price, middle, lower, upper, rsi].every(Number.isFinite)) {
    throw new Error("Indicadores inválidos");
  }

  return {
    price: price,
    rsi: rsi,
    upper: upper,
    middle: middle,
    lower: lower,
    candleTime: new Date(Number(closed[closed.length - 1][6])).toISOString()
  };
}

function getSignal(x, position) {
  if (position) {
    if (x.rsi > 60 || x.price >= x.middle) return "SELL";
    if (x.price <= position.stop) return "STOP";
    return "HOLD";
  }

  if (x.rsi < 30 && x.price <= x.lower) return "BUY";
  return "WAIT";
}

function scan() {
  state.status = "SCANNING";

  return Promise.all(CFG.symbols.map(function(symbol) {
    return getKlines(symbol).then(function(klines) {
      var x = getIndicators(klines);
      var position = state.positions[symbol];
      var signal = getSignal(x, position);

      if (!position && signal === "BUY") {
        var allocation = Math.min(state.cash, state.equity * CFG.positionPct);

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

        addEvent(signal === "STOP" ? "PAPER_STOP" : "PAPER_EXIT", symbol, {
          entry: position.entry,
          exit: exit,
          pnl: pnl,
          rsi: x.rsi,
          middle: x.middle
        });

        delete state.positions[symbol];
      }

      state.market[symbol] = Object.assign({}, x, {
        signal: signal,
        position: state.positions[symbol] || null
      });
    }).catch(function(error) {
      state.market[symbol] = {
        error: error.message,
        signal: "ERROR"
      };
      addEvent("DATA_ERROR", symbol, { message: error.message });
    });
  })).then(function() {
    state.floatingPnl = Object.keys(state.positions).reduce(function(sum, symbol) {
      var position = state.positions[symbol];
      var market = state.market[symbol];
      if (!market || !Number.isFinite(market.price)) return sum;
      return sum + ((market.price - position.entry) * position.qty);
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
  }).catch(function(error) {
    state.status = "PAPER_RUNNING";
    addEvent("SCAN_ERROR", null, { message: error.message });
  });
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
  res.status(200).sendFile(__dirname + "/index.html");
});

app.listen(PORT, "0.0.0.0", function() {
  console.log("SUPREMO PAPER listening on 0.0.0.0:" + PORT);
  scan();
  setInterval(function() {
    scan();
  }, CFG.pollMs);
});

process.on("uncaughtException", function(error) {
  console.error("UNCAUGHT_EXCEPTION", error);
  addEvent("PROCESS_ERROR", null, {
    message: error.message,
    stack: error.stack
  });
});

process.on("unhandledRejection", function(error) {
  console.error("UNHANDLED_REJECTION", error);
  addEvent("PROCESS_ERROR", null, { message: String(error) });
});
