# SUPREMO V10

PAPER scanner for Binance USD-M public market data.

## V10 change
The dashboard now calculates live total PnL as realized PnL plus the current unrealized net PnL of open positions. Unrealized PnL includes estimated round-trip fees and slippage. Equity is START + total PnL and updates with each state refresh. Each open position shows entry, live price, movement, net PnL and age.

Entry rule remains the last CLOSED 30-second candle direction only: green = LONG, red = SHORT. No RSI, MACD, score, momentum or edge filter.

PAPER only; no Binance API keys required.
