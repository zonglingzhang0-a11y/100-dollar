const test = require('node:test');
const assert = require('node:assert/strict');
const Drift = require('../src/engine.js');
const Story = require('../src/story.js');
const Lab = require('../src/lab.js');

const SEEDS = ['k3x9qa', 'qingshi', 'a1', 'zz', '梧桐'];
const MONTH = 24 * 30;
const ALL_RULES = Object.fromEntries(Drift.RULE_KEYS.map((k) => [k, true]));
// 原版、每条规矩单独开、全部打开
const RULESETS = [{ name: '原版', rules: null }]
  .concat(Drift.RULE_KEYS.map((k) => ({ name: k, rules: { [k]: true } })))
  .concat([{ name: '全开', rules: ALL_RULES }]);

const simFor = (seed, rules) => Drift.createSim(seed, rules ? { rules } : undefined);

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function netWorth(sim, i) {
  let worth = sim.state.people[i].cash + Drift.BILL * sim.notesHeld(i);
  for (const owed of sim.state.owe[i]) worth -= owed;
  return worth;
}

// 每个事件会让谁的身家变多少：买东西、帮工是一手交钱（或抵账）一手交货，“不用找了”是白送；
// 还账、找零、打欠条、清账只是换个记账的样子，谁的身家都不变。
function expectedDeltas(sim, events) {
  const delta = new Array(sim.town.residents.length).fill(0);
  const give = (from, to, amount) => {
    delta[from] -= amount;
    delta[to] += amount;
  };
  for (const ev of events) {
    if (ev.type === 'arrive') delta[ev.to] += Drift.BILL - ev.change;
    if (ev.type === 'credit' || ev.type === 'buy' || ev.type === 'cashBuy') give(ev.from, ev.to, ev.price);
    if (ev.type === 'refused') give(ev.from, ev.to, ev.paid);
    if (ev.type === 'workoff') give(ev.to, ev.from, ev.amount); // 债主买了一天的工
    if (ev.type === 'buy' || ev.type === 'repay') {
      for (const x of ev.extras) give(ev.from, ev.to, x.price);
      give(ev.from, ev.to, ev.forgiven);
    }
  }
  return delta;
}

test('同一个种子生成同一座小镇、同一段漂流', () => {
  for (const { rules } of [RULESETS[0], RULESETS[RULESETS.length - 1]]) {
    const a = simFor('k3x9qa', rules);
    const b = simFor('k3x9qa', rules);
    assert.deepEqual(a.town, b.town);
    for (let i = 0; i < 24 * 20; i++) assert.deepEqual(a.step(), b.step());
  }
  assert.notDeepEqual(Drift.createTown('k3x9qa').residents, Drift.createTown('k3x9qb').residents);
});

test('规矩全关时，故事和最初的版本一字不差', () => {
  // 这些指纹来自加规矩之前的引擎：前 60 天的全部事件。
  const golden = { k3x9qa: 'c7abcb2b', qingshi: 'c23b192c', 梧桐: '6586e6bd' };
  for (const opts of [undefined, {}, { rules: {} }, { rules: { creditCap: false } }]) {
    for (const seed of Object.keys(golden)) {
      const sim = Drift.createSim(seed, opts);
      const all = [];
      for (let i = 0; i < 24 * 60; i++) all.push(sim.step());
      assert.equal(fnv(JSON.stringify(all)), golden[seed], `${seed} ${JSON.stringify(opts)}`);
    }
  }
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

for (const { name, rules } of RULESETS) {
  test(`[${name}] 账本两边对得上，钱一分不多一分不少，身家变化都能被事件解释`, () => {
    for (const seed of SEEDS) {
      const sim = simFor(seed, rules);
      const n = sim.town.residents.length;
      const startCash = sim.totalMoney();
      for (let t = 0; t < MONTH; t++) {
        const before = [];
        for (let i = 0; i < n; i++) before.push(netWorth(sim, i));
        const events = sim.step();
        const at = `${seed} @ ${Drift.clock(sim.state.hour)}`;
        for (let a = 0; a < n; a++) {
          assert.equal(sim.state.owe[a][a], 0);
          for (let b = a + 1; b < n; b++) assert.equal(sim.state.owe[a][b] + sim.state.owe[b][a], 0, at);
        }
        assert.equal(sim.totalMoney(), startCash + sim.state.moneyIn, at);
        for (const p of sim.state.people) assert.ok(p.cash >= 0, `${at} 有人零钱成了负数`);
        const delta = expectedDeltas(sim, events);
        for (let i = 0; i < n; i++) {
          assert.equal(netWorth(sim, i) - before[i], delta[i], `${at} ${sim.town.residents[i].name}`);
        }
      }
    }
  });

  test(`[${name}] 每张钞票的去向和经手次数对得上，夜里不动，每件事都讲得成一句话`, () => {
    for (const seed of SEEDS) {
      const sim = simFor(seed, rules);
      const moves = sim.state.bills.map(() => 0);
      for (let t = 0; t < MONTH; t++) {
        const events = sim.step();
        const hh = sim.state.hour % 24;
        if (hh < Drift.DAY_START || hh >= Drift.DAY_END) assert.deepEqual(events, []);
        for (const ev of events) {
          if (ev.type === 'arrive' || ev.type === 'repay' || ev.type === 'buy') moves[ev.bill || 0]++;
          if (ev.type === 'repay' || ev.type === 'buy') assert.notEqual(ev.from, ev.to);
          const line = Story.narrate(ev, sim);
          assert.ok(line.text.length > 0, `${seed} ${ev.type} 没有文字`);
          assert.doesNotMatch(line.text, /undefined|NaN|\{n\}|null|Infinity|他|她/, line.text);
        }
      }
      sim.state.bills.forEach((note, k) => {
        assert.equal(note.stats.hands, moves[k], `${seed} 第 ${k} 张`);
        assert.equal(note.path.length, moves[k]);
        assert.ok(note.holder >= 0, `${seed} 第 ${k} 张钞票没进镇`);
        for (const mark of note.marks) assert.doesNotMatch(Story.markText(mark, sim.town), /\{n\}/);
      });
      assert.ok(moves[0] > 30, `${seed} 一个月只转手了 ${moves[0]} 次`);
    }
  });
}

test('赊账有度：赊出去的账不会让人欠过上限', () => {
  const cap = Drift.RULE_PARAMS.creditCap.cap;
  let refused = 0;
  let checked = 0;
  let overCap = 0;
  for (const seed of SEEDS.concat(['b'])) {
    const sim = simFor(seed, { creditCap: true });
    for (let t = 0; t < MONTH * 3; t++) {
      const events = sim.step();
      for (const ev of events) {
        if (ev.type === 'refused') {
          refused++;
          assert.ok(ev.paid === 0 || ev.paid === ev.price);
          const text = Story.narrate(ev, sim).text;
          if (ev.total > ev.cap) overCap++;
          if (ev.total > ev.cap) assert.doesNotMatch(text, /这一笔就过/, text);
          else assert.match(text, /这一笔就过/, text);
        }
        if (ev.type !== 'credit') continue;
        // 这个钟头里买主只出现在这一笔赊账里，才能拿收工后的账本核对
        const involved = events.filter((e) => e.from === ev.from || e.to === ev.from || e.who === ev.from);
        if (involved.length !== 1) continue;
        checked++;
        assert.ok(sim.payables(ev.from) <= cap, `${seed} ${Drift.clock(ev.hour)} 赊完欠了 ${sim.payables(ev.from)}`);
      }
    }
  }
  assert.ok(refused > 0, '三个月里一次都没拒赊过');
  assert.ok(overCap > 0, '没碰到本来就欠过上限的人');
  assert.ok(checked > 100);
});

test('以工抵债：只有欠得多、没零钱、好些天没摸到钞票的人才去帮工', () => {
  const W = Drift.RULE_PARAMS.workoff;
  let workdays = 0;
  for (const seed of SEEDS) {
    const sim = simFor(seed, { workoff: true });
    for (let t = 0; t < MONTH * 3; t++) {
      for (const ev of sim.step()) {
        if (ev.type !== 'workoff') continue;
        workdays++;
        assert.ok(ev.amount > 0 && ev.amount <= W.wage);
        assert.equal(ev.owed - ev.amount, ev.remaining);
        assert.ok(ev.days >= W.idleDays);
        assert.equal(ev.hour % 24, W.hour);
        assert.ok(sim.state.people[ev.from].cash < W.wage);
        assert.equal(sim.notesHeld(ev.from), 0);
      }
    }
  }
  assert.ok(workdays > 0);
});

test('以工抵债：“几天没摸到钞票”从钞票离手的那一刻算起', () => {
  const W = Drift.RULE_PARAMS.workoff;
  let checked = 0;
  for (const seed of SEEDS) {
    for (const rules of [{ workoff: true }, { workoff: true, secondTraveler: true }]) {
      const sim = simFor(seed, rules);
      for (let t = 0; t < MONTH * 4; t++) {
        for (const ev of sim.step()) {
          if (ev.type !== 'workoff') continue;
          let last = Drift.DAY_START;
          for (const note of sim.state.bills) {
            for (const p of note.path) if (p.hour <= ev.hour && (p.to === ev.from || p.from === ev.from)) last = Math.max(last, p.hour);
          }
          assert.equal(ev.days, Math.floor((ev.hour - last) / 24), `${seed} ${Drift.clock(ev.hour)}`);
          assert.ok(ev.days >= W.idleDays);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 20);
});

test('两张钞票在同一个人手里，持有的钟点也只算一遍', () => {
  for (const seed of SEEDS.concat(['x136'])) {
    const sim = simFor(seed, { secondTraveler: true });
    for (let t = 0; t < MONTH; t++) sim.step();
    // 第 h 个钟头开始时手里有钞票的人，这个钟头记一小时：拿到是第 r 个钟头、交出去是第 f 个钟头，就记 (r, f]
    const hours = sim.state.people.map(() => new Set());
    for (const note of sim.state.bills) {
      let holder = -1;
      let since = 0;
      const close = (until) => {
        if (holder >= 0) for (let h = since + 1; h <= until; h++) hours[holder].add(h);
      };
      for (const p of note.path) {
        close(p.hour);
        holder = p.to;
        since = p.hour;
      }
      close(sim.state.hour);
    }
    sim.state.people.forEach((p, i) => assert.equal(p.hoursHeld, hours[i].size, `${seed} ${sim.town.residents[i].name}`));
  }
});

test('照顾生意：抵账加现钱正好是货价', () => {
  let buys = 0;
  for (const seed of SEEDS) {
    const sim = simFor(seed, { patronage: true });
    for (let t = 0; t < MONTH; t++) {
      for (const ev of sim.step()) {
        if (ev.type !== 'cashBuy') continue;
        buys++;
        assert.equal(ev.cash + ev.offset, ev.price);
        assert.ok(ev.cash >= 0 && ev.offset >= 0);
        assert.notEqual(ev.from, ev.to);
      }
    }
  }
  assert.ok(buys > 50);
});

// 欠账图里还有没有绕成圈的账（深度优先找回边）
function hasCycle(owe) {
  const n = owe.length;
  const color = new Array(n).fill(0);
  const visit = (a) => {
    color[a] = 1;
    for (let b = 0; b < n; b++) {
      if (owe[a][b] <= 0) continue;
      if (color[b] === 1) return true;
      if (color[b] === 0 && visit(b)) return true;
    }
    color[a] = 2;
    return false;
  };
  for (let a = 0; a < n; a++) if (color[a] === 0 && visit(a)) return true;
  return false;
}

test('三角债清理：每一圈至少三户，勾销的数目对得上，清完不留圈', () => {
  let clearings = 0;
  for (const seed of SEEDS) {
    const sim = simFor(seed, { netting: true });
    for (let t = 0; t < MONTH * 3; t++) {
      for (const ev of sim.step()) {
        if (ev.type !== 'clearing') continue;
        clearings++;
        assert.equal(Drift.dayOf(ev.hour) % Drift.RULE_PARAMS.netting.every, 0);
        let sum = 0;
        for (const c of ev.cycles) {
          assert.ok(c.members.length >= 3 && c.amount > 0);
          assert.equal(new Set(c.members).size, c.members.length);
          sum += c.amount * c.members.length;
        }
        assert.equal(ev.cancelled, sum);
        assert.equal(hasCycle(sim.state.owe), false, `${seed} ${Drift.clock(ev.hour)} 清完账还有圈`);
      }
    }
  }
  assert.ok(clearings >= SEEDS.length * 12);
});

test('第二位外乡人：第 2 天早上带着另一张钞票进镇', () => {
  for (const seed of SEEDS) {
    const sim = simFor(seed, { secondTraveler: true });
    const arrivals = [];
    for (let t = 0; t < 24 * 3; t++) for (const ev of sim.step()) if (ev.type === 'arrive') arrivals.push(ev);
    assert.equal(arrivals.length, 2);
    assert.deepEqual(arrivals.map((a) => a.bill), [0, 1]);
    assert.deepEqual(arrivals.map((a) => Drift.dayOf(a.hour)), [1, 2]);
    assert.notEqual(sim.state.bills[0].serial, sim.state.bills[1].serial);
    assert.equal(sim.state.bills[0].serial, sim.town.serial);
  }
});

test('一年下来：改变“谁挣谁花”的规矩能让欠账稳住，只改怎么付钱的不行', () => {
  const year = (rules) => Lab.runAll({ seed: 'regression', towns: 24, days: 365, rules });
  const quarter = (r) => r.drift * 90;
  const base = year(null);
  assert.ok(base.final > 1.2 && quarter(base) > 0.2, `原版 ${base.final}`);
  for (const key of ['creditCap', 'patronage', 'workoff']) {
    const r = year({ [key]: true });
    assert.ok(r.final < 0.8, `${key} 一年后 ${r.final}`);
    assert.ok(Math.abs(quarter(r)) < 0.1, `${key} 最后三个月变了 ${quarter(r)}`);
  }
  for (const key of ['netting', 'secondTraveler']) {
    const r = year({ [key]: true });
    assert.ok(r.final > 1.0 && quarter(r) > 0.15, `${key} 一年后 ${r.final}，最后三个月 ${quarter(r)}`);
  }
  const three = year({ creditCap: true, patronage: true, workoff: true });
  assert.ok(three.final < 0.5 && Math.abs(quarter(three)) < 0.05);
});
