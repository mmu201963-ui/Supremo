# SUPREMO — Mean Reversion 4H

Versión PAPER para probar exactamente la estrategia solicitada.

## Reglas
- Mercado: BTC/USDT y ETH/USDT en Binance.
- Timeframe: 4h.
- RSI(14).
- Bollinger: SMA20, desviación 2.
- COMPRA: RSI < 30 Y precio <= banda inferior.
- VENTA: RSI > 60 O precio >= banda media (SMA20).
- Stop-loss: 4% desde la entrada (configurable entre 3% y 5%).
- Tamaño: máximo 5% del capital por posición.
- Sin promediar a la baja.
- PAPER: no coloca órdenes reales.

## Importante
La estrategia puede fallar durante tendencias fuertes. Este proyecto no garantiza beneficios.

El bot utiliza la última vela 4H CERRADA para calcular RSI/Bollinger y evitar señales basadas en una vela todavía incompleta.

## Railway
1. Sube este proyecto.
2. `npm install`
3. `npm start`
4. Railway debe proporcionar `PORT`.
5. Abre la URL pública del servicio.

Variables opcionales:
- `INITIAL_CAPITAL=10000`
- `POSITION_PCT=0.05`
- `STOP_PCT=0.04`
- `POLL_MS=30000`

No necesita API keys porque esta versión es PAPER y usa únicamente datos públicos de Binance.
