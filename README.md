# SUPREMO V12 ADAPTIVE REGIME

PAPER only. No Binance API keys required.

Objetivo:
- No intentar invertir señales.
- Determinar régimen BULL / BEAR / RANGE / VOLATILE.
- Buscar LONG en BULL y SHORT en BEAR.
- No operar en VOLATILE.
- No llenar posiciones por obligación.
- Máximo físico 4 posiciones.
- Máximo 1 entrada por ciclo.
- Score mínimo 8.
- Riesgo máximo 2% de equity por posición.
- Cooldown 45 minutos por símbolo.
- Gestión por ATR con TP/SL y salida por cambio de régimen.
- Escanea todos los perpetuos USD-M USDT disponibles.

Railway:
Start Command: npm start

IMPORTANTE:
Esta versión no garantiza beneficios. Es una arquitectura de prueba PAPER para medir si el filtro de régimen y la selección de entradas mejora el V11.
