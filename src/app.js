/*
 * 百元漂流记 · 页面
 *
 * 只负责画：地图、钞票档案、流水账和欠账曲线。所有故事都来自 Drift（引擎）和 Story（讲故事）。
 */
(function () {
  'use strict';

  const { createSim, clock, dayOf, DAY_START, DAY_END, BILL } = window.Drift;
  const Story = window.Story;
  const Lab = window.Lab;
  const NS = 'http://www.w3.org/2000/svg';
  const SPEEDS = { slow: 900, mid: 320, fast: 70 }; // 每个白天钟点的毫秒数；夜里快五倍
  const JOURNAL_LIMIT = 400;
  const TRAIL = 10;
  const MOVES = new Set(['arrive', 'repay', 'buy']);
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Math.round(n).toLocaleString('zh-CN');

  function svg(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  let sim = null;
  let seed = '';
  let playing = false;
  let speed = 'mid';
  let timer = null;
  let selected = -1;
  let flight = null;
  let houses = [];
  let edgeEls = new Map();
  let layers = {};
  let hover = -1; // 曲线上被指着的点
  let renderedMarks = -1; // 票面痕迹列表上一次画了几条

  // ---------- 种子 ----------

  function randomSeed() {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function seedFromHash() {
    const h = (location.hash || '').slice(1);
    return /^[A-Za-z0-9._~-]{1,32}$/.test(h) ? h : '';
  }

  function writeHash(s) {
    if (!/^[A-Za-z0-9._~-]{1,32}$/.test(s)) return;
    try {
      history.replaceState(null, '', '#' + s);
    } catch (e) {
      /* 有些嵌入环境不让改地址，没关系 */
    }
  }

  // ---------- 地图 ----------

  function buildMap() {
    const town = sim.town;
    const root = $('map');
    root.textContent = '';
    root.setAttribute('viewBox', '0 0 ' + town.width + ' ' + town.height);

    const defs = svg('defs', {}, root);
    const marker = svg('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 7, refY: 5, markerWidth: 10, markerHeight: 10, markerUnits: 'userSpaceOnUse', orient: 'auto' }, defs);
    svg('path', { d: 'M0,1 L9,5 L0,9 z', class: 'arrowhead' }, marker);

    svg('rect', { x: 0, y: 0, width: town.width, height: town.height, class: 'ground' }, root);
    const streets = svg('g', { class: 'streets' }, root);
    const main = town.streets.main;
    svg('rect', { x: 0, y: main.y - 15, width: town.width, height: 30, class: 'street' }, streets);
    for (const lane of town.streets.lanes) {
      svg('rect', { x: lane.x - 9, y: lane.y1, width: 18, height: lane.y2 - lane.y1, class: 'street' }, streets);
      const t = svg('text', { x: lane.x, y: lane.y1 - 10, class: 'street-name', 'text-anchor': 'middle' }, streets);
      t.textContent = lane.name;
    }
    const mainName = svg('text', { x: 495, y: main.y + 5, class: 'street-name', 'text-anchor': 'middle' }, streets);
    mainName.textContent = main.name;
    const road = svg('text', { x: 14, y: main.y + 5, class: 'street-name' }, streets);
    road.textContent = '官道';

    svg('rect', { x: 0, y: 0, width: town.width, height: town.height, class: 'dusk' }, root);
    layers.edges = svg('g', { class: 'edges' }, root);
    layers.trail = svg('g', { class: 'trail' }, root);
    layers.houses = svg('g', { class: 'houses' }, root);
    // 每张钞票一个小钞票；0 号最后画，压在最上面。
    layers.bills = [];
    for (let k = sim.state.bills.length - 1; k >= 0; k--) {
      const g = svg('g', { class: k ? 'bill other' : 'bill', 'aria-hidden': 'true' }, root);
      svg('rect', { x: -17, y: -9, width: 34, height: 18, rx: 2 }, g);
      svg('text', { y: 3.5 }, g).textContent = '100';
      g.style.display = 'none';
      layers.bills[k] = g;
    }
    layers.bill = layers.bills[0];

    houses = town.residents.map((r) => {
      const g = svg('g', {
        class: 'house',
        transform: 'translate(' + r.x + ' ' + r.y + ')',
        tabindex: 0,
        role: 'button',
        'aria-label': r.trade.title + r.name,
      }, layers.houses);
      svg('title', {}, g).textContent = r.trade.title + r.name;
      svg('circle', { r: 33, class: 'halo' }, g);
      svg('rect', { x: -22, y: -22, width: 44, height: 44, rx: 5, class: 'lot' }, g);
      svg('text', { y: 8.5, class: 'sign' }, g).textContent = r.trade.sign;
      svg('text', { y: 41, class: 'name' }, g).textContent = r.name;
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        select(selected === r.id ? -1 : r.id);
      });
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select(selected === r.id ? -1 : r.id);
        }
      });
      return g;
    });
    edgeEls = new Map();
  }

  // 两户人家之间的弧线，两头各让出房子的位置。
  function arc(a, b, bend, trimA, trimB) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const cx = (a.x + b.x) / 2 - (dy / d) * bend * d;
    const cy = (a.y + b.y) / 2 + (dx / d) * bend * d;
    const toward = (p, len) => {
      const ux = cx - p.x;
      const uy = cy - p.y;
      const l = Math.hypot(ux, uy) || 1;
      return { x: p.x + (ux / l) * len, y: p.y + (uy / l) * len };
    };
    return { s: toward(a, trimA), c: { x: cx, y: cy }, e: toward(b, trimB) };
  }

  function arcPath(k) {
    return 'M' + k.s.x.toFixed(1) + ',' + k.s.y.toFixed(1) + ' Q' + k.c.x.toFixed(1) + ',' + k.c.y.toFixed(1) + ' ' + k.e.x.toFixed(1) + ',' + k.e.y.toFixed(1);
  }

  function renderEdges() {
    const town = sim.town;
    const focus = selected >= 0 ? selected : sim.state.holder;
    const seen = new Set();
    for (const e of sim.debtEdges()) {
      const key = e.from + '>' + e.to;
      seen.add(key);
      let path = edgeEls.get(key);
      if (!path) {
        path = svg('path', { class: 'edge', 'marker-end': 'url(#arrow)' }, layers.edges);
        path.setAttribute('d', arcPath(arc(town.residents[e.from], town.residents[e.to], 0.14, 28, 32)));
        edgeEls.set(key, path);
      }
      path.style.strokeWidth = Math.min(6, 1 + e.amount / 40).toFixed(2);
      path.classList.toggle('hot', focus >= 0 && (e.from === focus || e.to === focus));
    }
    for (const [key, path] of edgeEls) {
      if (!seen.has(key)) {
        path.remove();
        edgeEls.delete(key);
      }
    }
    $('map').classList.toggle('focused', selected >= 0);
  }

  function renderHouses() {
    houses.forEach((g, id) => {
      g.classList.toggle('holder', id === sim.state.holder);
      g.classList.toggle('selected', id === selected);
      g.setAttribute('aria-pressed', id === selected ? 'true' : 'false');
    });
  }

  function renderTrail() {
    const town = sim.town;
    layers.trail.textContent = '';
    const path = sim.state.bill.path.filter((p) => p.from >= 0).slice(-TRAIL);
    path.forEach((p, i) => {
      const k = arc(town.residents[p.from], town.residents[p.to], -0.22, 24, 24);
      const line = svg('path', { d: arcPath(k) }, layers.trail);
      line.style.opacity = (0.15 + (0.75 * (i + 1)) / path.length).toFixed(2);
    });
  }

  // 小钞票夹在持有人房子的右上角。
  function billSpot(id) {
    const r = sim.town.residents[id];
    return { x: r.x + 20, y: r.y - 26 };
  }

  function placeBill(p) {
    layers.bill.style.display = '';
    layers.bill.setAttribute('transform', 'translate(' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ') rotate(-8)');
  }

  // 另外几张钞票夹在持有人房子的左上角，不做飞行动画。
  function renderOtherNotes() {
    sim.state.bills.forEach((note, k) => {
      if (!k) return;
      const g = layers.bills[k];
      if (note.holder < 0) {
        g.style.display = 'none';
        return;
      }
      const r = sim.town.residents[note.holder];
      g.style.display = '';
      g.setAttribute('transform', 'translate(' + (r.x - 20 - (k - 1) * 8) + ' ' + (r.y - 26 + (k - 1) * 4) + ') rotate(8)');
    });
  }

  // 手机上地图比屏幕宽：钞票换手时把镜头挪过去。
  function follow(id) {
    const box = $('mapScroll');
    if (box.scrollWidth <= box.clientWidth + 1) return;
    const scale = $('map').clientWidth / sim.town.width;
    const left = Math.max(0, sim.town.residents[id].x * scale - box.clientWidth / 2);
    box.scrollTo({ left, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function fly(from, to) {
    if (flight) flight.finish();
    const end = billSpot(to);
    if (from < 0 || reduceMotion) {
      placeBill(end);
      return;
    }
    const start = billSpot(from);
    const d = Math.hypot(end.x - start.x, end.y - start.y);
    const ctrl = { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - 30 - d * 0.18 };
    const duration = Math.min(700, SPEEDS[speed] * 0.85);
    const t0 = performance.now();
    let raf = 0;
    const finish = () => {
      cancelAnimationFrame(raf);
      placeBill(end);
      flight = null;
    };
    const frame = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const u = 1 - k;
      placeBill({
        x: u * u * start.x + 2 * u * k * ctrl.x + k * k * end.x,
        y: u * u * start.y + 2 * u * k * ctrl.y + k * k * end.y,
      });
      if (t < 1) raf = requestAnimationFrame(frame);
      else finish();
    };
    flight = { finish };
    raf = requestAnimationFrame(frame);
  }

  // ---------- 镇民档案 ----------

  function select(id) {
    selected = id;
    renderPerson();
    renderHouses();
    renderEdges();
  }

  function renderPerson() {
    const box = $('person');
    if (selected < 0) {
      box.hidden = true;
      box.textContent = '';
      return;
    }
    const town = sim.town;
    const r = town.residents[selected];
    const p = sim.state.people[selected];
    const owe = sim.state.owe[selected];
    box.hidden = false;
    box.textContent = '';

    const head = document.createElement('div');
    head.className = 'person-head';
    const sign = document.createElement('div');
    sign.className = 'person-sign';
    sign.textContent = r.trade.sign;
    const who = document.createElement('div');
    const h2 = document.createElement('h2');
    h2.textContent = r.name;
    const sub = document.createElement('p');
    sub.textContent = r.trade.title + ' · ' + r.temper;
    who.append(h2, sub);
    const close = document.createElement('button');
    close.className = 'person-close';
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    close.textContent = '×';
    close.addEventListener('click', () => select(-1));
    head.append(sign, who, close);

    const dl = document.createElement('dl');
    const row = (k, v) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    };
    row('零钱', fmt(p.cash) + ' 块');
    row('拿过钞票', p.timesHeld ? p.timesHeld + ' 次，共 ' + p.hoursHeld + ' 小时' : '还没有');
    row('常去', r.favorites.map((f) => town.residents[f].trade.shop).join('、'));

    const list = (title, cls, entries) => {
      const wrap = document.createElement('div');
      const h3 = document.createElement('h3');
      h3.textContent = title;
      const ul = document.createElement('ul');
      ul.className = cls;
      if (!entries.length) {
        const li = document.createElement('li');
        li.className = 'none';
        li.textContent = '没有';
        ul.append(li);
      }
      for (const e of entries) {
        const li = document.createElement('li');
        const a = document.createElement('span');
        a.textContent = town.residents[e.id].trade.title + town.residents[e.id].name;
        const b = document.createElement('span');
        b.textContent = fmt(e.amount) + ' 块';
        li.append(a, b);
        ul.append(li);
      }
      wrap.append(h3, ul);
      return wrap;
    };
    const owes = [];
    const owed = [];
    owe.forEach((v, id) => {
      if (v > 0) owes.push({ id, amount: v });
      if (v < 0) owed.push({ id, amount: -v });
    });
    owes.sort((x, y) => y.amount - x.amount);
    owed.sort((x, y) => y.amount - x.amount);
    box.append(head, dl, list('欠别人', 'owes', owes), list('别人欠', 'owed', owed));
  }

  // ---------- 钞票档案 ----------

  function grade(c) {
    if (c >= 98) return '全新';
    if (c >= 92) return '九五品';
    if (c >= 85) return '九品';
    if (c >= 75) return '八品';
    if (c >= 60) return '七品';
    return '流通旧票';
  }

  function renderNote() {
    const { state, town } = sim;
    $('serial').textContent = town.serial;
    const c = sim.condition();
    $('grade').textContent = grade(c);
    $('condition').textContent = c + '%';
    $('hands').textContent = state.stats.hands + ' 次';
    const where = $('where');
    where.textContent = '';
    if (state.holder < 0) {
      where.textContent = '钞票还在外乡人的兜里。';
    } else {
      const r = town.residents[state.holder];
      const hh = state.hour % 24;
      const night = hh < DAY_START || hh >= DAY_END;
      const strong = document.createElement('strong');
      strong.textContent = r.trade.title + r.name;
      where.append('现在在', strong, night ? '家的' + Story.place(r) + '里过夜。' : '手里，已经 ' + state.heldFor + ' 小时。');
    }
    for (const note of state.bills.slice(1)) {
      const tail = '尾号 ' + note.serial.split(' ')[1].slice(-4);
      const today = dayOf(state.hour) >= note.arriveDay;
      if (note.holder < 0) where.append('第二位外乡人' + (today ? '今早八点' : '明早') + '到，会再带来一张（' + tail + '）。');
      else where.append('另一张（' + tail + '）在' + town.residents[note.holder].name + '手里。');
    }
    let longest = state.stats.longestHold;
    if (state.holder >= 0 && state.heldFor > longest.hours) longest = { id: state.holder, hours: state.heldFor };
    $('longest').textContent = longest.id >= 0 ? town.residents[longest.id].name + ' ' + longest.hours + ' 小时' : '—';

    const ol = $('marks');
    const marks = state.bill.marks;
    if (renderedMarks === marks.length) return;
    renderedMarks = marks.length;
    ol.textContent = '';
    if (!marks.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '还很新，没留下什么痕迹。';
      ol.append(li);
      return;
    }
    for (const m of marks) {
      const li = document.createElement('li');
      li.textContent = Story.markText(m, town);
      ol.append(li);
    }
  }

  // ---------- 流水账 ----------

  function addEntries(events, fresh) {
    const list = $('journal');
    const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    const frag = document.createDocumentFragment();
    for (const ev of events) {
      const line = Story.narrate(ev, sim);
      if (!line.text) continue;
      const li = document.createElement('li');
      if (line.kind === 'day') {
        li.className = 'day';
        li.textContent = line.text;
      } else {
        li.className = 'entry ' + line.kind + (fresh && line.kind !== 'muted' ? ' fresh' : '');
        const time = document.createElement('time');
        time.textContent = clock(ev.hour).slice(-5);
        const p = document.createElement('p');
        p.textContent = line.text;
        if (line.kind === 'rule') {
          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = '规矩';
          p.prepend(tag);
        }
        li.append(time, p);
      }
      frag.append(li);
    }
    list.querySelectorAll('.fresh').forEach((n) => n.classList.remove('fresh'));
    list.append(frag);
    while (list.childElementCount > JOURNAL_LIMIT) list.firstElementChild.remove();
    if (stick || !fresh) list.scrollTop = list.scrollHeight;
  }

  // ---------- 数字和曲线 ----------

  function renderNumbers() {
    const { stats, holder } = sim.state;
    const tile = (id, value, note) => {
      const dd = $(id);
      dd.textContent = value;
      const small = document.createElement('small');
      small.textContent = note || ' ';
      dd.append(small);
    };
    tile('repaid', fmt(stats.debtRepaid) + ' 块', stats.debtRepaid ? '是它面值的 ' + (stats.debtRepaid / BILL).toFixed(1) + ' 倍' : '');
    tile('commerce', fmt(stats.commerce) + ' 块', stats.commerce ? '住店、买米、做衣裳……' : '');
    tile('ious', fmt(stats.iouCreated) + ' 块', '零头算了的有 ' + fmt(stats.forgiven) + ' 块');
    tile('holders', stats.holders.size + ' 位', '全镇 ' + sim.town.residents.length + ' 户');
    renderRuleLine();
    const punch = $('punchline');
    if (holder < 0) punch.textContent = '外乡人还没进镇。';
    else {
      const now = sim.grossDebt();
      const diff = sim.state.initialGross - now;
      punch.textContent =
        '全镇欠账从 ' + fmt(sim.state.initialGross) + ' 块' + (diff >= 0 ? '降到 ' : '涨到 ') + fmt(now) + ' 块。';
    }
  }

  // 开着的规矩在这座镇里做了多少事
  function renderRuleLine() {
    const R = sim.state.ruleStats;
    const on = sim.rules;
    const bits = [];
    if (on.creditCap) bits.push('拒赊 ' + R.refused + ' 回' + (R.refusedCash ? '，其中当场现买 ' + fmt(R.refusedCash) + ' 块' : ''));
    if (on.workoff) bits.push('帮工 ' + R.workdays + ' 天，抵掉 ' + fmt(R.workedOff) + ' 块');
    if (on.patronage) bits.push('拿闲钱买东西 ' + fmt(R.patronage) + ' 块，其中特意照顾欠债人家 ' + fmt(R.patronageNeedy) + ' 块');
    if (on.netting) bits.push('赶集清账 ' + R.clearings + ' 回，勾销 ' + fmt(R.cleared) + ' 块');
    if (sim.state.bills.length > 1) {
      let hands = 0;
      for (const note of sim.state.bills.slice(1)) hands += note.stats.hands;
      bits.push('另一张钞票转手 ' + hands + ' 次');
    }
    const line = $('ruleLine');
    line.hidden = !bits.length;
    line.textContent = '';
    if (!bits.length) return;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '规矩';
    line.append(tag, bits.join('；') + '。');
  }

  function niceMax(v) {
    if (v <= 0) return 100;
    const step = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * step >= v) return m * step;
    return 10 * step;
  }

  let chartGeom = null;

  // 图表的外壳（<svg> 和提示框）只建一次，之后每次重画只换 <svg> 里面的内容，
  // 这样键盘焦点、指针状态和提示都不会因为重画而丢掉。
  function chartShell(box, label, tipId, on) {
    let el = box.querySelector('svg');
    if (el) return el;
    box.textContent = '';
    el = document.createElementNS(NS, 'svg');
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label);
    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.id = tipId;
    tip.hidden = true;
    box.append(el, tip);
    el.addEventListener('pointermove', (e) => on.pick(e.clientX, el));
    el.addEventListener('pointerdown', (e) => on.pick(e.clientX, el));
    // 触屏上点一下就让提示留着，点别处（失焦）再收起；在图上滑动页面会触发 pointercancel，也收起。
    el.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch') on.hide();
    });
    el.addEventListener('pointercancel', () => on.hide());
    el.addEventListener('blur', () => on.hide());
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      on.step(e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey);
    });
    return el;
  }

  function renderChart() {
    const box = $('chart');
    const el = chartShell(box, '全镇欠账总额随时间的变化', 'tip', {
      pick: (clientX, svgEl) => {
        if (!chartGeom) return;
        const rect = svgEl.getBoundingClientRect();
        const x = ((clientX - rect.left) / rect.width) * chartGeom.W;
        const data = sim.state.grossDebt;
        let best = 0;
        let bestD = Infinity;
        data.forEach((d, i) => {
          const dd = Math.abs(chartGeom.sx(d.hour) - x);
          if (dd < bestD) {
            bestD = dd;
            best = i;
          }
        });
        showHover(best);
      },
      hide: () => showHover(-1),
      step: (dir) => {
        const n = sim.state.grossDebt.length;
        showHover(Math.max(0, Math.min(n - 1, hover < 0 ? n - 1 : hover + dir)));
      },
    });
    const data = sim.state.grossDebt;
    const W = Math.max(280, Math.round(box.clientWidth || 600));
    const H = 190;
    const pad = { l: 46, r: 64, t: 16, b: 26 };
    const x0 = data[0].hour;
    const x1 = Math.max(data[data.length - 1].hour, x0 + 24 * 3);
    let vmax = 0;
    for (const d of data) vmax = Math.max(vmax, d.value);
    const ymax = niceMax(vmax);
    const sx = (h) => pad.l + ((h - x0) / (x1 - x0)) * (W - pad.l - pad.r);
    const sy = (v) => pad.t + (1 - v / ymax) * (H - pad.t - pad.b);
    chartGeom = { sx, sy, W, H, pad };

    let s = '<g class="grid">';
    for (const v of [0, ymax / 2, ymax]) s += '<line x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + sy(v) + '" y2="' + sy(v) + '"/>';
    s += '</g><g class="axis">';
    for (const v of [0, ymax / 2, ymax]) s += '<text x="' + (pad.l - 8) + '" y="' + (sy(v) + 4) + '" text-anchor="end">' + fmt(v) + '</text>';
    const days = (x1 - x0) / 24;
    const every = Math.max(1, Math.ceil(days / Math.max(2, Math.floor((W - pad.l - pad.r) / 64))));
    for (let day = 1; day * 24 <= x1; day += every) {
      const h = (day - 1) * 24 + DAY_START;
      if (h < x0) continue;
      s += '<text x="' + sx(h) + '" y="' + (H - 6) + '" text-anchor="middle">第' + day + '天</text>';
    }
    s += '</g>';
    let line = '';
    data.forEach((d, i) => (line += (i ? 'L' : 'M') + sx(d.hour).toFixed(1) + ',' + sy(d.value).toFixed(1)));
    const last = data[data.length - 1];
    const area = line + 'L' + sx(last.hour).toFixed(1) + ',' + sy(0) + 'L' + sx(x0) + ',' + sy(0) + 'Z';
    s += '<path class="area" d="' + area + '"/><path class="line" d="' + line + '"/>';
    s += '<line class="cross" id="cross" y1="' + pad.t + '" y2="' + sy(0) + '" style="display:none"/>';
    s += '<circle class="dot" cx="' + sx(last.hour) + '" cy="' + sy(last.value) + '" r="4.5"/>';
    s += '<circle class="dot" id="hoverDot" r="4.5" style="display:none"/>';
    s += '<text class="label" x="' + (sx(last.hour) + 9) + '" y="' + (sy(last.value) + 4) + '">' + fmt(last.value) + '</text>';
    if (data.length > 1) s += '<text class="label" x="' + (sx(x0) + 4) + '" y="' + (sy(data[0].value) - 9) + '">起初 ' + fmt(data[0].value) + '</text>';
    s += '<rect x="' + pad.l + '" y="0" width="' + (W - pad.l - pad.r + 8) + '" height="' + H + '" fill="transparent"/>';
    el.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    el.innerHTML = s;
    if (hover >= data.length) hover = -1;
    showHover(hover);
  }

  function showHover(i) {
    hover = i;
    const box = $('chart');
    const tip = $('tip');
    const cross = box.querySelector('#cross');
    const dot = box.querySelector('#hoverDot');
    if (!tip || !cross || !chartGeom) return;
    if (i < 0) {
      tip.hidden = true;
      cross.style.display = 'none';
      dot.style.display = 'none';
      return;
    }
    const d = sim.state.grossDebt[i];
    const { sx, sy, W } = chartGeom;
    const x = sx(d.hour);
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.style.display = '';
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', sy(d.value));
    dot.style.display = '';
    const value = document.createElement('strong');
    value.textContent = fmt(d.value) + ' 块';
    const when = document.createElement('span');
    when.textContent = clock(d.hour);
    tip.textContent = '';
    tip.append(value, when);
    tip.hidden = false;
    const px = (x / W) * box.clientWidth;
    const half = tip.offsetWidth / 2;
    tip.style.left = Math.max(half, Math.min(box.clientWidth - half, px)) + 'px';
  }

  function renderTable() {
    if (!$('tableView').open) return;
    const rows = [];
    const data = sim.state.grossDebt;
    const movesByDay = {};
    for (const p of sim.state.bill.path) {
      const day = Math.floor(p.hour / 24) + 1;
      movesByDay[day] = (movesByDay[day] || 0) + 1;
    }
    const endOfDay = {};
    for (const d of data) endOfDay[Math.floor(d.hour / 24) + 1] = d.value;
    const tbody = $('dayRows');
    tbody.textContent = '';
    for (const day of Object.keys(endOfDay)) rows.push([day, endOfDay[day], movesByDay[day] || 0]);
    for (const [day, debt, moves] of rows) {
      const tr = document.createElement('tr');
      for (const v of ['第 ' + day + ' 天', fmt(debt) + ' 块', moves + ' 次']) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.append(td);
      }
      tbody.append(tr);
    }
  }

  // ---------- 时钟和播放 ----------

  function renderClock() {
    const hh = sim.state.hour % 24;
    const night = hh < DAY_START || hh >= DAY_END;
    const c = $('clock');
    c.textContent = clock(sim.state.hour);
    const phase = document.createElement('span');
    phase.className = 'phase';
    phase.textContent = night ? '夜里，铺子都关了' : hh < 11 ? '上午' : hh < 14 ? '晌午' : hh < 18 ? '下午' : '傍晚';
    c.append(phase);
    $('mapCard').classList.toggle('night', night);
  }

  function renderAll() {
    renderClock();
    renderEdges();
    renderHouses();
    renderTrail();
    renderOtherNotes();
    renderNote();
    renderNumbers();
    renderChart();
    renderTable();
    if (selected >= 0) renderPerson();
  }

  function apply(events, animate) {
    let lastMove = null;
    for (const ev of events) if (MOVES.has(ev.type) && !(ev.bill > 0)) lastMove = ev; // 只跟着 0 号钞票
    if (lastMove) {
      const from = lastMove.type === 'arrive' ? -1 : lastMove.from;
      if (animate) fly(from, lastMove.to);
      else placeBill(billSpot(lastMove.to));
      follow(lastMove.to);
    }
    if (events.length) addEntries(events, animate);
    renderAll();
  }

  function schedule() {
    clearTimeout(timer);
    if (!playing) return;
    const hh = (sim.state.hour + 1) % 24;
    const night = hh < DAY_START || hh >= DAY_END;
    timer = setTimeout(tick, night ? SPEEDS[speed] / 5 : SPEEDS[speed]);
  }

  function tick() {
    apply(sim.step(), true);
    schedule();
  }

  function setPlaying(on) {
    playing = on;
    $('play').setAttribute('aria-pressed', on ? 'true' : 'false');
    $('playLabel').textContent = on ? '暂停' : '播放';
    $('playIcon').innerHTML = on ? '<path d="M3 1.5h3v11H3zM8 1.5h3v11H8z"/>' : '<path d="M3 1.5v11l9-5.5z"/>';
    schedule();
  }

  // ---------- 镇上的规矩 + 长期实验 ----------

  // 每条规矩在页面上的说法；key 对应引擎 createSim(seed, { rules }) 里的开关。
  const RULE_COPY = [
    { key: 'creditCap', title: '赊账有度', desc: '谁要是再赊一笔，欠全镇的账加起来就会过 200 块，谁家都不肯赊；兜里零钱够的，可以当场现买。' },
    { key: 'workoff', title: '以工抵债', desc: '欠了 200 块以上、手头没钱、又一个礼拜没摸到钞票的人，去最大的债主那里帮一天工，30 块工钱抵账。' },
    { key: 'patronage', title: '照顾生意', desc: '手头宽裕的人常拿闲钱出门买东西，一半时候特意去欠债的人家照顾生意；收了现钱的人转手先还账。' },
    { key: 'netting', title: '三角债清理', desc: '逢七赶集，商会账房把绕成圈的欠账（甲欠乙、乙欠丙、丙又欠甲）按圈上最小的一笔对冲掉。' },
    { key: 'secondTraveler', title: '第二位外乡人', desc: '第 2 天早上又来一位外乡人，也付一张百元钞住一晚，镇上的整钞多了一倍。' },
  ];
  const LAB_TOWNS = 40;
  const LAB_DAYS = 365;
  let rules = {};
  const labCache = new Map(); // “种子|规矩” → 实验结果
  const lab = { key: '', base: null, mine: null, job: null, hover: -1, geom: null, series: [] };

  function activeRules() {
    const on = {};
    for (const r of RULE_COPY) if (rules[r.key]) on[r.key] = true;
    return Object.keys(on).length ? on : null;
  }

  function buildRules() {
    const box = $('rules');
    box.querySelectorAll('.rule-card').forEach((n) => n.remove());
    for (const r of RULE_COPY) {
      const label = document.createElement('label');
      label.className = 'rule-card';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = 'rule-' + r.key;
      input.checked = !!rules[r.key];
      input.addEventListener('change', () => {
        // 重开小镇会改变上面几块的高度；把页面挪回去，让刚点的这条规矩还在指针底下
        const before = input.getBoundingClientRect().top;
        const run = document.querySelector('.lab-run');
        run.style.minHeight = run.offsetHeight + 'px'; // 算完之前别让下面变矮，免得页面在底部时整体往下掉
        rules[r.key] = input.checked;
        start(seed);
        window.scrollBy(0, input.getBoundingClientRect().top - before);
      });
      const name = document.createElement('strong');
      name.textContent = r.title;
      const desc = document.createElement('span');
      desc.textContent = r.desc;
      label.append(input, name, desc);
      box.append(label);
    }
  }

  function labKey(rs) {
    return seed + '|' + JSON.stringify(rs);
  }

  // 原来的规矩和勾选的规矩各跑 40 座小镇一年；一小片一小片地跑，别卡住页面。
  function runLab() {
    const mine = activeRules();
    const key = labKey(mine);
    if (lab.key === key) return;
    if (lab.job) clearTimeout(lab.job.timer);
    lab.key = key;
    lab.base = labCache.get(labKey(null)) || null;
    lab.mine = mine ? labCache.get(key) || null : null;
    const runs = [];
    if (!lab.base) runs.push({ rules: null, run: Lab.createRun({ seed, towns: LAB_TOWNS, days: LAB_DAYS }) });
    if (mine && !lab.mine) runs.push({ rules: mine, run: Lab.createRun({ seed, towns: LAB_TOWNS, days: LAB_DAYS, rules: mine }) });
    if (!runs.length) {
      lab.job = null;
      labDone();
      return;
    }
    const job = { timer: 0 };
    lab.job = job;
    const total = runs.length * LAB_TOWNS;
    $('labMeter').hidden = false;
    $('labMeter').firstElementChild.style.width = '0%';
    $('labStatus').textContent = '正在模拟第 1 / ' + total + ' 座小镇……';
    renderLab();
    const slice = () => {
      if (lab.job !== job) return;
      const t0 = performance.now();
      let current = runs.find((r) => !r.run.done);
      while (current && performance.now() - t0 < 12) {
        current.run.next();
        if (current.run.done) current = runs.find((r) => !r.run.done);
      }
      let finished = 0;
      for (const r of runs) finished += Math.round(r.run.progress * r.run.towns);
      $('labMeter').firstElementChild.style.width = ((100 * finished) / total).toFixed(1) + '%';
      $('labStatus').textContent = '正在模拟第 ' + Math.min(total, finished + 1) + ' / ' + total + ' 座小镇……';
      if (current) {
        job.timer = setTimeout(slice, 0);
        return;
      }
      for (const r of runs) {
        const result = r.run.result();
        labCache.set(labKey(r.rules), result);
        if (r.rules) lab.mine = result;
        else lab.base = result;
      }
      lab.job = null;
      labDone();
    };
    job.timer = setTimeout(slice, 60);
  }

  function labDone() {
    document.querySelector('.lab-run').style.minHeight = '';
    $('labMeter').hidden = true;
    $('labStatus').textContent = LAB_TOWNS + ' 座小镇，各模拟 ' + LAB_DAYS + ' 天';
    renderLab();
  }

  const times = (v) => v.toFixed(2) + ' 倍';

  function trendText(r) {
    const quarter = r.drift * 90;
    if (Math.abs(quarter) < 0.05) return '最后三个月基本走平';
    return quarter > 0 ? '最后三个月还在往上涨' : '最后三个月还在往下走';
  }

  function renderVerdict() {
    const p = $('labVerdict');
    p.textContent = '';
    const b = lab.base;
    const m = lab.mine;
    if (!b) {
      p.textContent = '正在算……';
      return;
    }
    const strong = (t) => {
      const el = document.createElement('strong');
      el.textContent = t;
      return el;
    };
    if (!m && activeRules()) {
      p.append('照原来的规矩，一年后欠账的中位数是开局的 ', strong(times(b.final)), '，' + trendText(b) + '。勾选的规矩还在算……');
    } else if (m) {
      p.append('加上勾选的规矩，一年后欠账的中位数是开局的 ', strong(times(m.final)), '，' + trendText(m) + '；原来的规矩下是 ', strong(times(b.final)), '，' + trendText(b) + '。');
    } else {
      p.append('照原来的规矩，一年后欠账的中位数是开局的 ', strong(times(b.final)), '，' + trendText(b) + '。最低点在第 ' + b.lowDay + ' 天，只有开局的 ' + times(b.low) + '。勾上任意一条规矩，图上会多出一条线来对比。');
    }
  }

  function renderLab() {
    renderVerdict();
    $('labLegendNew').hidden = !lab.mine;
    const box = $('labChart');
    box.classList.toggle('stale', !!lab.job);
    const el = chartShell(box, '一年里全镇欠账相对开局的变化，原来的规矩和勾选的规矩对比', 'labTip', {
      pick: (clientX, svgEl) => {
        const g = lab.geom;
        if (!g) return;
        const rect = svgEl.getBoundingClientRect();
        const x = ((clientX - rect.left) / rect.width) * g.W;
        const d = Math.round(((x - g.pad.l) / (g.W - g.pad.l - g.pad.r)) * (g.days - 1));
        labHover(Math.max(0, Math.min(g.days - 1, d)));
      },
      hide: () => labHover(-1),
      step: (dir, big) => {
        const g = lab.geom;
        if (!g) return;
        const d = lab.hover < 0 ? g.days - 1 : lab.hover + dir * (big ? 30 : 1);
        labHover(Math.max(0, Math.min(g.days - 1, d)));
      },
    });
    const series = [];
    if (lab.base) series.push({ id: 'base', name: '原来', r: lab.base });
    if (lab.mine) series.push({ id: 'new', name: '勾选', r: lab.mine });
    lab.series = series;
    if (!series.length) {
      el.innerHTML = '';
      lab.geom = null;
      labHover(-1);
      return;
    }
    const W = Math.max(280, Math.round(box.clientWidth || 600));
    const H = 230;
    const pad = { l: 50, r: 18, t: 14, b: 26 };
    let top = 1.2;
    for (const sr of series) for (const v of sr.r.p90) top = Math.max(top, v);
    const step = top <= 2 ? 0.5 : top <= 4 ? 1 : 2;
    const ymax = Math.ceil(top / step) * step;
    const days = series[0].r.days;
    const sx = (d) => pad.l + (d / (days - 1)) * (W - pad.l - pad.r);
    const sy = (v) => pad.t + (1 - v / ymax) * (H - pad.t - pad.b);
    lab.geom = { sx, sy, W, days, pad };

    let s = '<g class="grid">';
    for (let v = 0; v <= ymax + 1e-9; v += step) s += '<line x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + sy(v) + '" y2="' + sy(v) + '"/>';
    s += '</g><g class="axis">';
    for (let v = 0; v <= ymax + 1e-9; v += step) s += '<text x="' + (pad.l - 8) + '" y="' + (sy(v) + 4) + '" text-anchor="end">' + (v === 0 ? '0' : v + ' 倍') + '</text>';
    const marks = W < 520 ? [1, 180, 365] : [1, 90, 180, 270, 365];
    for (const d of marks) s += '<text x="' + sx(d - 1) + '" y="' + (H - 6) + '" text-anchor="' + (d === 1 ? 'start' : d === 365 ? 'end' : 'middle') + '">第' + d + '天</text>';
    s += '</g>';
    s += '<line class="one" x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + sy(1) + '" y2="' + sy(1) + '"/>';
    const path = (arr) => arr.map((v, d) => (d ? 'L' : 'M') + sx(d).toFixed(1) + ',' + sy(v).toFixed(1)).join('');
    for (const sr of series) {
      const upper = path(sr.r.p90);
      const lower = sr.r.p10.map((v, d) => 'L' + sx(d).toFixed(1) + ',' + sy(v).toFixed(1)).reverse().join('');
      s += '<path class="' + sr.id + '-band" d="' + upper + lower + 'Z"/>';
    }
    for (const sr of series) {
      s += '<path class="' + sr.id + '-line" d="' + path(sr.r.median) + '"/>';
      s += '<circle class="' + sr.id + '-dot" cx="' + sx(days - 1) + '" cy="' + sy(sr.r.final) + '" r="4.5"/>';
    }
    s += '<text class="label" x="' + (pad.l + 6) + '" y="' + (sy(1) - 6) + '">开局</text>';
    s += '<line class="cross" id="labCross" y1="' + pad.t + '" y2="' + sy(0) + '" style="display:none"/>';
    el.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    el.innerHTML = s;
    labHover(lab.hover < days ? lab.hover : -1);
    renderLabTable(series);
  }

  function labHover(d) {
    lab.hover = d;
    const box = $('labChart');
    const tip = $('labTip');
    const cross = $('labCross');
    if (!tip) return;
    if (d < 0 || !lab.geom || !cross) {
      tip.hidden = true;
      if (cross) cross.style.display = 'none';
      return;
    }
    const x = lab.geom.sx(d);
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.style.display = '';
    tip.textContent = '';
    const head = document.createElement('span');
    head.textContent = '第 ' + (d + 1) + ' 天';
    tip.append(head);
    for (const sr of lab.series) {
      const row = document.createElement('div');
      row.className = 'row';
      const key = document.createElement('i');
      key.style.background = sr.id === 'base' ? 'var(--debt)' : 'var(--note)';
      const v = document.createElement('b');
      v.textContent = times(sr.r.median[d]);
      const range = document.createElement('span');
      range.textContent = sr.name + '　' + sr.r.p10[d].toFixed(2) + '–' + sr.r.p90[d].toFixed(2);
      row.append(key, v, range);
      tip.append(row);
    }
    tip.hidden = false;
    const px = (x / lab.geom.W) * box.clientWidth;
    const half = tip.offsetWidth / 2;
    tip.style.left = Math.max(half, Math.min(box.clientWidth - half, px)) + 'px';
  }

  function renderLabTable(series) {
    const head = $('labHead');
    const body = $('labRows');
    head.textContent = '';
    body.textContent = '';
    const hr = document.createElement('tr');
    for (const t of ['日子'].concat(series.map((sr) => sr.name + '（中位数）'), series.map((sr) => sr.name + '（中间 80%）'))) {
      const th = document.createElement('th');
      th.textContent = t;
      hr.append(th);
    }
    head.append(hr);
    const days = series[0].r.days;
    for (let d = 30; d <= days; d += 30) rowFor(d - 1);
    if (days % 30) rowFor(days - 1);
    function rowFor(i) {
      const tr = document.createElement('tr');
      const cells = ['第 ' + (i + 1) + ' 天']
        .concat(series.map((sr) => times(sr.r.median[i])))
        .concat(series.map((sr) => sr.r.p10[i].toFixed(2) + '–' + sr.r.p90[i].toFixed(2)));
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      body.append(tr);
    }
  }

  // ---------- 启动 ----------

  function start(newSeed, targetHour) {
    clearTimeout(timer);
    if (flight) flight.finish();
    seed = newSeed;
    sim = createSim(seed, activeRules() ? { rules: activeRules() } : undefined);
    selected = -1;
    hover = -1;
    $('seed').value = seed;
    $('townName').textContent = sim.town.name;
    document.title = '百元漂流记 · ' + sim.town.name;
    writeHash(seed);
    buildMap();
    $('legendOther').hidden = sim.state.bills.length < 2;
    $('journal').textContent = '';
    $('person').hidden = true;
    renderedMarks = -1;

    // 开场先走到外乡人进镇，这样一打开就有故事可看。
    const events = [];
    const until = Math.max(targetHour || 0, 0);
    events.push.apply(events, sim.stepUntilMove(24));
    while (sim.state.hour < until) events.push.apply(events, sim.step());
    if (sim.state.holder >= 0) {
      placeBill(billSpot(sim.state.holder));
      follow(sim.state.holder);
    }
    addEntries(events.slice(-JOURNAL_LIMIT * 2), false);
    renderAll();
    schedule();
    runLab();
  }

  function wire() {
    $('play').addEventListener('click', () => setPlaying(!playing));
    $('next').addEventListener('click', () => {
      setPlaying(false);
      apply(sim.stepUntilMove(), true);
    });
    document.querySelectorAll('input[name="speed"]').forEach((r) =>
      r.addEventListener('change', () => {
        speed = r.value;
        schedule();
      }),
    );
    $('seedForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const value = $('seed').value.trim() || randomSeed();
      start(value);
    });
    $('shuffle').addEventListener('click', () => start(randomSeed()));
    $('townLife').addEventListener('change', (e) => $('journal').classList.toggle('no-town', !e.target.checked));
    $('tableView').addEventListener('toggle', renderTable);
    buildRules();
    $('map').addEventListener('click', () => {
      if (selected >= 0) select(-1);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && selected >= 0) select(-1);
    });
    // 图表重画的那一刻指针刚好移出去，浏览器可能不发 pointerleave；鼠标挪到别处时补一下。
    document.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      if (hover >= 0 && !$('chart').contains(e.target)) showHover(-1);
      if (lab.hover >= 0 && !$('labChart').contains(e.target)) labHover(-1);
    });
    if (window.ResizeObserver) {
      let last = 0;
      new ResizeObserver((entries) => {
        const w = Math.round(entries[0].contentRect.width);
        if (w !== last && sim) {
          last = w;
          renderChart();
        }
      }).observe($('chart'));
      let labWidth = 0;
      new ResizeObserver((entries) => {
        const w = Math.round(entries[0].contentRect.width);
        if (w !== labWidth && lab.base) {
          labWidth = w;
          renderLab();
        }
      }).observe($('labChart'));
    }
    if (window.claude && window.claude.hot && window.claude.hot.snapshot) {
      window.claude.hot.snapshot(() => ({ seed, hour: sim ? sim.state.hour : 0, playing, speed, rules }));
    }
  }

  function boot(data) {
    data = data || {};
    if (data.rules && typeof data.rules === 'object') rules = Object.assign({}, data.rules);
    wire();
    if (data.speed && SPEEDS[data.speed]) {
      speed = data.speed;
      const radio = $('speed-' + speed);
      if (radio) radio.checked = true;
    }
    start(data.seed || seedFromHash() || randomSeed(), data.hour);
    setPlaying(data.playing !== undefined ? !!data.playing : true);
  }

  const hot = window.claude && window.claude.hot;
  if (hot && hot.ready) hot.ready(boot);
  else boot((hot && hot.data) || {});
})();
