const test = require('node:test');
const assert = require('node:assert/strict');
const Lab = require('../src/lab.js');

test('分位数按线性插值取', () => {
  assert.equal(Lab.quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(Lab.quantile([0, 10], 0.1), 1);
  assert.equal(Lab.quantile([7], 0.9), 7);
});

test('同一个种子、同一套规矩，实验结果完全一样', () => {
  const a = Lab.runAll({ seed: 'k3x9qa', towns: 6, days: 40 });
  const b = Lab.runAll({ seed: 'k3x9qa', towns: 6, days: 40 });
  assert.deepEqual(a, b);
  const c = Lab.runAll({ seed: 'other', towns: 6, days: 40 });
  assert.notDeepEqual(a.median, c.median);
});

test('一座一座地跑，进度和结果对得上', () => {
  const run = Lab.createRun({ seed: 'k3x9qa', towns: 5, days: 30 });
  assert.equal(run.result(), null);
  let steps = 0;
  while (run.next()) {
    steps++;
    assert.equal(run.progress, steps / 5);
  }
  assert.equal(steps, 5);
  assert.equal(run.done, true);
  assert.equal(run.next(), false);
  const r = run.result();
  assert.equal(r.towns, 5);
  assert.equal(r.median.length, 30);
  for (let d = 0; d < 30; d++) {
    assert.ok(r.p10[d] <= r.median[d] && r.median[d] <= r.p90[d], `第 ${d + 1} 天分位数顺序不对`);
  }
  assert.equal(r.final, r.median[29]);
  assert.equal(r.low, Math.min(...r.median));
});
