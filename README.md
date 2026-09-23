# SUPREMO Mean Reversion 4H V3.1

Esta versión corrige el problema conceptual de la pantalla anterior.

Cambios:
- RSI estándar de Wilder(14), no un promedio simple.
- Precio actual separado de los indicadores 4H.
- RSI y Bollinger se calculan con la última vela 4H cerrada para evitar señales que cambien mientras la vela está abierta.
- El precio usado para comprobar las reglas es el ticker actual de Binance.
- La pantalla muestra ambos mercados: BTCUSDT y ETHUSDT.
- Si RSI > 60 o precio >= SMA20 y no hay posición, muestra `CONDICIÓN DE VENTA · SIN POSICIÓN` en vez de esconder la condición como WAIT.
- Si hay posición y se cumple la salida, muestra `SEÑAL DE VENTA` y cierra en PAPER.
- Compra solamente cuando RSI < 30 Y precio actual <= BB inferior.
- Stop 4% por defecto; configurable 3–5%.
- Máximo 5% del capital por posición.
- PAPER: no coloca órdenes reales y no necesita API keys.

Railway:
Start Command: npm start
