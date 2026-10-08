const test = require('node:test');
const assert = require('node:assert/strict');
const Drift = require('../src/engine.js');
const Story = require('../src/story.js');

const SEEDS = ['k3x9qa', 'qingshi', 'a1', 'zz', '梧桐'];
const MONTH = 24 * 30;

function netWorth(sim, i) {
  const { state } = sim;
  let worth = state.people[i].cash + (state.holder === i ? Drift.BILL : 0);
  for (const owed of state.owe[i]) worth -= owed;
  return worth;
}

// 每个事件会让谁的身家变多少：买东西是一手交钱一手交货，“不用找了”是白送。
function expectedDeltas(sim, events) {
  const delta = new Array(sim.town.residents.length).fill(0);
  const give = (from, to, amount) => {
    delta[from] -= amount;
    delta[to] += amount;
  };
  for (const ev of events) {
    if (ev.type === 'arrive') delta[ev.to] += Drift.BILL - ev.change;
    if (ev.type === 'credit') give(ev.from, ev.to, ev.price);
    if (ev.type === 'buy') give(ev.from, ev.to, ev.price);
    if (ev.type === 'buy' || ev.type === 'repay') {
      for (const x of ev.extras) give(ev.from, ev.to, x.price);
      give(ev.from, ev.to, ev.forgiven);
    }
  }
  return delta;
}

test('同一个种子生成同一座小镇、同一段漂流', () => {
  const a = Drift.createSim('k3x9qa');
  const b = Drift.createSim('k3x9qa');
  assert.deepEqual(a.town, b.town);
  for (let i = 0; i < 500; i++) assert.deepEqual(a.step(), b.step());
  assert.notDeepEqual(Drift.createTown('k3x9qa').residents, Drift.createTown('k3x9qb').residents);
});

test('房子都在地图里，彼此不挤在一起', () => {
  for (const seed of SEEDS) {
    const town = Drift.createTown(seed);
    for (const r of town.residents) {
      assert.ok(r.x >= 40 && r.x <= town.width - 40, `${seed} ${r.name} x=${r.x}`);
      assert.ok(r.y >= 40 && r.y <= town.height - 40, `${seed} ${r.name} y=${r.y}`);
    }
    for (const r of town.residents) {
      for (const o of town.residents) {
        if (r.id < o.id) assert.ok(Math.hypot(r.x - o.x, r.y - o.y) >= 60, `${seed} ${r.name} / ${o.name}`);
      }
    }
    assert.equal(new Set(town.residents.map((r) => r.name)).size, town.residents.length);
    assert.equal(town.residents[0].trade.id, 'inn');
  }
});

test('账本两边永远对得上', () => {
  for (const seed of SEEDS) {
    const sim = Drift.createSim(seed);
    const n = sim.town.residents.length;
    for (let t = 0; t < MONTH; t++) {
      sim.step();
      for (let a = 0; a < n; a++) {
        assert.equal(sim.state.owe[a][a], 0);
        for (let b = 0; b < n; b++) assert.equal(sim.state.owe[a][b] + sim.state.owe[b][a], 0);
      }
    }
  }
});

test('外乡人走后，镇上的钱一分不多一分不少', () => {
  for (const seed of SEEDS) {
    const sim = Drift.createSim(seed);
    const startCash = sim.totalMoney();
    sim.stepUntilMove();
    const expected = startCash + Drift.BILL - sim.state.arrivalChange;
    assert.equal(sim.totalMoney(), expected);
    for (let t = 0; t < MONTH; t++) {
      sim.step();
      assert.equal(sim.totalMoney(), expected, `${seed} @ ${Drift.clock(sim.state.hour)}`);
      for (const p of sim.state.people) assert.ok(p.cash >= 0, `${seed} 有人零钱成了负数`);
    }
  }
});

test('每个人身家的变化都能被事件解释', () => {
  for (const seed of SEEDS) {
    const sim = Drift.createSim(seed);
    const n = sim.town.residents.length;
    for (let t = 0; t < MONTH; t++) {
      const before = [];
      for (let i = 0; i < n; i++) before.push(netWorth(sim, i));
      const events = sim.step();
      const delta = expectedDeltas(sim, events);
      for (let i = 0; i < n; i++) {
        assert.equal(netWorth(sim, i) - before[i], delta[i], `${seed} ${sim.town.residents[i].name} @ ${Drift.clock(sim.state.hour)}`);
      }
    }
  }
});

test('钞票的去向和经手次数对得上', () => {
  for (const seed of SEEDS) {
    const sim = Drift.createSim(seed);
    let moves = 0;
    for (let t = 0; t < MONTH; t++) {
      for (const ev of sim.step()) {
        if (ev.type === 'arrive' || ev.type === 'repay' || ev.type === 'buy') {
          moves++;
          assert.equal(sim.state.holder >= 0, true);
        }
        if (ev.type === 'repay' || ev.type === 'buy') assert.notEqual(ev.from, ev.to);
      }
    }
    assert.equal(sim.state.stats.hands, moves);
    assert.equal(sim.state.bill.path.length, moves);
    assert.ok(moves > 30, `${seed} 一个月只转手了 ${moves} 次`);
  }
});

test('夜里钞票不动', () => {
  const sim = Drift.createSim('k3x9qa');
  for (let t = 0; t < MONTH; t++) {
    const events = sim.step();
    const hh = sim.state.hour % 24;
    if (hh < Drift.DAY_START || hh >= Drift.DAY_END) assert.deepEqual(events, []);
  }
});

test('每个事件都能讲成一句完整的话', () => {
  for (const seed of SEEDS) {
    const sim = Drift.createSim(seed);
    for (let t = 0; t < MONTH; t++) {
      for (const ev of sim.step()) {
        const line = Story.narrate(ev, sim);
        assert.ok(line.text.length > 0, `${seed} ${ev.type} 没有文字`);
        assert.doesNotMatch(line.text, /undefined|NaN|\{n\}|null/, line.text);
      }
    }
    for (const mark of sim.state.bill.marks) assert.doesNotMatch(Story.markText(mark, sim.town), /\{n\}/);
  }
});
