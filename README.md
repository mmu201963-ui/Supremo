# SUPREMO V8 — 30s Candle Trend PAPER

Fix de estabilidad del WebSocket de V7. El cierre/reconexión ya no elimina el listener de `error` antes de `terminate()`, evitando el crash observado en Railway.

## Entrada
- Vela de 30 segundos.
- Verde = LONG.
- Roja = SHORT.
- Sin RSI, MACD, score, aceleración ni filtro de edge para decidir la entrada.

## Feed
- WebSocket público Binance USD-M.
- Reconexión automática.
- Fallback público de precios si no llegan datos.
- PAPER solamente; no usa API keys ni envía órdenes reales.

## Inicio
`npm start`

## Importante
La estrategia de vela no garantiza utilidad. Debe validarse con PAPER antes de cualquier uso LIVE.
