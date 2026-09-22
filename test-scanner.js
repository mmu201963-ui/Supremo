const assert=require('node:assert');
function net(move){return 100*move*5-100*5*.0004*2-100*5*.0002*2}
assert(net(.006)>0);assert(net(-.004)<0);console.log('COST_MODEL_TEST=PASS');
