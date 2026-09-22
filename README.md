# SUPREMO V4 — Global Low-Latency Profit Engine PAPER

PAPER-only Binance USD-M Futures scanner. No API keys and no real orders.

## V4 changes
- Single global `!miniTicker@arr` WebSocket feed first; avoids hundreds of individual subscriptions.
- Automatic reconnect/watchdog when data stops.
- Live-stream symbol discovery if REST `exchangeInfo` is unavailable.
- Real data coverage shown as `ticks / markets`.
- 250 ms local radar loop in RAM.
- LONG/SHORT ranking using velocity, acceleration, persistence and exhaustion.
- Net-edge gate includes fee + slippage assumptions.
- Rotation/cooldown to reduce repeated symbols.
- Paper TP/SL/timeout and PnL/drawdown statistics.
- The engine does not claim profitability; PAPER results must establish whether a net edge exists.

## Railway
Start command: `node server.js`

Do not add Binance API keys for this PAPER version.
