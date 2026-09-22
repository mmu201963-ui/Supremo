const assert = require('node:assert/strict');
function direction(open, close) { return close > open ? 'LONG' : close < open ? 'SHORT' : null; }
assert.equal(direction(100, 101), 'LONG');
assert.equal(direction(100, 99), 'SHORT');
assert.equal(direction(100, 100), null);
console.log('CANDLE_DIRECTION_TEST=PASS');
