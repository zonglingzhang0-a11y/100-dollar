/*
 * 百元漂流记 · 页面
 *
 * 只负责画：地图、钞票档案、流水账和欠账曲线。所有故事都来自 Drift（引擎）和 Story（讲故事）。
 */
(function () {
  'use strict';

  const { createSim, clock, DAY_START, DAY_END, BILL } = window.Drift;
  const Story = window.Story;
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
    layers.bill = svg('g', { class: 'bill', 'aria-hidden': 'true' }, root);
    svg('rect', { x: -17, y: -9, width: 34, height: 18, rx: 2 }, layers.bill);
    svg('text', { y: 3.5 }, layers.bill).textContent = '100';
    layers.bill.style.display = 'none';

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
    let longest = state.stats.longestHold;
    if (state.holder >= 0 && state.heldFor > longest.hours) longest = { id: state.holder, hours: state.heldFor };
    $('longest').textContent = longest.id >= 0 ? town.residents[longest.id].name + ' ' + longest.hours + ' 小时' : '—';

    const ol = $('marks');
    const marks = state.bill.marks;
    if (ol.childElementCount === marks.length && marks.length) return;
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
    const punch = $('punchline');
    if (holder < 0) punch.textContent = '外乡人还没进镇。';
    else {
      const now = sim.grossDebt();
      const diff = sim.state.initialGross - now;
      punch.textContent =
        '全镇欠账从 ' + fmt(sim.state.initialGross) + ' 块' + (diff >= 0 ? '降到 ' : '涨到 ') + fmt(now) + ' 块。';
    }
  }

  function niceMax(v) {
    if (v <= 0) return 100;
    const step = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * step >= v) return m * step;
    return 10 * step;
  }

  let chartGeom = null;

  function renderChart() {
    const box = $('chart');
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

    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" tabindex="0" role="img" aria-label="全镇欠账总额随时间的变化">';
    s += '<g class="grid">';
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
    s += '<rect id="hit" x="' + pad.l + '" y="0" width="' + (W - pad.l - pad.r + 8) + '" height="' + H + '" fill="transparent"/>';
    s += '</svg><div class="tip" id="tip" hidden><strong></strong><span></span></div>';
    box.innerHTML = s;

    const chartSvg = box.querySelector('svg');
    const pick = (clientX) => {
      const rect = chartSvg.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * W;
      let best = 0;
      let bestD = Infinity;
      data.forEach((d, i) => {
        const dd = Math.abs(sx(d.hour) - x);
        if (dd < bestD) {
          bestD = dd;
          best = i;
        }
      });
      showHover(best);
    };
    chartSvg.addEventListener('pointermove', (e) => pick(e.clientX));
    chartSvg.addEventListener('pointerdown', (e) => pick(e.clientX));
    chartSvg.addEventListener('pointerleave', () => showHover(-1));
    chartSvg.addEventListener('blur', () => showHover(-1));
    chartSvg.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const i = hover < 0 ? data.length - 1 : hover + (e.key === 'ArrowLeft' ? -1 : 1);
      showHover(Math.max(0, Math.min(data.length - 1, i)));
    });
    if (hover >= 0 && hover < data.length) showHover(hover);
  }

  function showHover(i) {
    hover = i;
    const box = $('chart');
    const tip = $('tip');
    const cross = box.querySelector('#cross');
    const dot = box.querySelector('#hoverDot');
    if (!tip || !chartGeom) return;
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
    tip.hidden = false;
    tip.querySelector('strong').textContent = fmt(d.value) + ' 块';
    tip.querySelector('span').textContent = clock(d.hour);
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
    renderNote();
    renderNumbers();
    renderChart();
    renderTable();
    if (selected >= 0) renderPerson();
  }

  function apply(events, animate) {
    let lastMove = null;
    for (const ev of events) if (MOVES.has(ev.type)) lastMove = ev;
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

  // ---------- 启动 ----------

  function start(newSeed, targetHour) {
    clearTimeout(timer);
    if (flight) flight.finish();
    seed = newSeed;
    sim = createSim(seed);
    selected = -1;
    hover = -1;
    $('seed').value = seed;
    $('townName').textContent = sim.town.name;
    document.title = '百元漂流记 · ' + sim.town.name;
    writeHash(seed);
    buildMap();
    $('journal').textContent = '';
    $('person').hidden = true;

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
    $('map').addEventListener('click', () => {
      if (selected >= 0) select(-1);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && selected >= 0) select(-1);
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
    }
    if (window.claude && window.claude.hot && window.claude.hot.snapshot) {
      window.claude.hot.snapshot(() => ({ seed, hour: sim ? sim.state.hour : 0, playing, speed }));
    }
  }

  function boot(data) {
    data = data || {};
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
