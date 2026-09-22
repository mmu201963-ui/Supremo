# SUPREMO V9

PAPER-only Binance USD-M scanner. Entry uses only the **last CLOSED 30-second candle**: green = LONG, red = SHORT. The current forming candle is never used for entry. No RSI, MACD, momentum score, edge model, or external trend indicators.

The change is intentional: V7/V8 could enter while the 30s candle was still forming, so a candle that looked green could reverse before close. V9 waits for the candle to close, enters once per symbol per closed candle, and manages positions with TP/SL/time only.

No Binance API keys are required for PAPER.
