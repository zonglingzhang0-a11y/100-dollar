/*
 * 百元漂流记 · 模拟引擎
 *
 * 纯逻辑，不碰 DOM。同一个种子永远生成同一座小镇、同一段漂流。
 * 浏览器里挂到 window.Drift，Node 里通过 module.exports 导出。
 *
 * 记账约定：owe[a][b] > 0 表示 a 欠 b 这么多钱，且始终保持 owe[a][b] === -owe[b][a]。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Drift = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BILL = 100;
  const DAY_START = 7; // 铺子 7 点开门
  const DAY_END = 21; // 21 点关门，夜里钞票不动
  const SMALL_CHANGE = 10; // 找不开的零头不超过这个数，就“不用找了”
  const ROOM_PRICE = 80; // 外乡人住一晚的价钱
  const MAP_W = 1000;
  const MAP_H = 620;

  // ---------- 可复现的随机数 ----------

  function hashSeed(str) {
    // xmur3
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^ (h >>> 16)) >>> 0;
  }

  function makeRng(seed) {
    let a = hashSeed(String(seed));
    // mulberry32
    const next = function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
    next.pick = (arr) => arr[Math.floor(next() * arr.length)];
    next.chance = (p) => next() < p;
    next.shuffle = (arr) => {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    };
    return next;
  }

  // ---------- 小镇的素材 ----------

  // 第一项必须是客栈：外乡人从这里把钞票带进小镇。
  const TRADES = [
    { id: 'inn', title: '客栈掌柜', sign: '栈', shop: '客栈', stain: '一圈酒杯压出的水印', items: [['一碗阳春面', 12], ['一桌家常菜', 68], ['一壶黄酒', 30]] },
    { id: 'baker', title: '面点师傅', sign: '饼', shop: '饼铺', stain: '一层薄薄的面粉', items: [['两个烧饼', 6], ['一笼包子', 15], ['一盒桃酥', 24]] },
    { id: 'butcher', title: '屠户', sign: '肉', shop: '肉铺', stain: '一点洗不掉的油渍', items: [['一刀五花肉', 45], ['两根排骨', 38], ['一副猪蹄', 26]] },
    { id: 'farmer', title: '农户', sign: '米', shop: '米摊', stain: '一粒干在纸上的泥点', items: [['一袋新米', 60], ['一筐青菜', 18], ['一篮鸡蛋', 22]] },
    { id: 'fisher', title: '渔夫', sign: '鱼', shop: '鱼摊', stain: '一股散不掉的鱼腥味', items: [['一条鲈鱼', 35], ['一捧河虾', 28]] },
    { id: 'tailor', title: '裁缝', sign: '衣', shop: '裁缝铺', stain: '一根缠在折痕里的红线', items: [['改一条裤脚', 15], ['做一件衬衫', 85], ['做一身棉袄', 140]] },
    { id: 'carpenter', title: '木匠', sign: '木', shop: '木作坊', stain: '几道铅笔画的尺寸线', items: [['修一把椅子', 40], ['打一个书柜', 160]] },
    { id: 'smith', title: '铁匠', sign: '铁', shop: '铁匠铺', stain: '一枚黑乎乎的指印', items: [['磨一把菜刀', 10], ['打一把锄头', 75]] },
    { id: 'barber', title: '剃头匠', sign: '剪', shop: '剃头铺', stain: '一股桂花头油的香味', items: [['理个发', 20], ['刮个脸', 12]] },
    { id: 'doctor', title: '大夫', sign: '医', shop: '医馆', stain: '半行潦草的药方', items: [['看一次诊', 50], ['针灸一回', 65]] },
    { id: 'herbalist', title: '药铺掌柜', sign: '药', shop: '药铺', stain: '一股淡淡的当归味', items: [['三副草药', 42], ['一盒膏药', 18]] },
    { id: 'teahouse', title: '茶馆掌柜', sign: '茶', shop: '茶馆', stain: '一圈浅浅的茶渍', items: [['一壶碧螺春', 16], ['一碟瓜子', 5]] },
    { id: 'books', title: '书铺掌柜', sign: '书', shop: '书铺', stain: '一道被书页压出的直痕', items: [['一本旧小说', 14], ['一套字帖', 32]] },
    { id: 'florist', title: '花匠', sign: '花', shop: '花圃', stain: '一片压扁的栀子花瓣', items: [['一束栀子', 22], ['一盆兰草', 55]] },
    { id: 'cobbler', title: '鞋匠', sign: '鞋', shop: '鞋铺', stain: '一点黑鞋油', items: [['补一双鞋', 18], ['做一双布鞋', 48]] },
    { id: 'tofu', title: '豆腐坊老板', sign: '豆', shop: '豆腐坊', stain: '一块豆浆干掉的白印', items: [['两块豆腐', 8], ['一碗豆花', 4]] },
    { id: 'brewer', title: '酿酒师傅', sign: '酒', shop: '酒坊', stain: '一股酒糟的甜味', items: [['一坛米酒', 58], ['一壶烧酒', 26]] },
    { id: 'watchmaker', title: '钟表匠', sign: '钟', shop: '钟表铺', stain: '一个只有放大镜才看得见的螺丝印', items: [['修一块怀表', 80], ['换一根发条', 25]] },
    { id: 'potter', title: '陶匠', sign: '陶', shop: '陶器铺', stain: '一抹干掉的陶泥', items: [['一只粗瓷碗', 9], ['一口腌菜缸', 70]] },
    { id: 'painter', title: '画匠', sign: '画', shop: '画坊', stain: '一点群青颜料', items: [['画一张小像', 90], ['写一副春联', 20]] },
    { id: 'teacher', title: '私塾先生', sign: '塾', shop: '私塾', stain: '背面几行练字的小楷', items: [['教一个月书', 120], ['代写一封信', 8]] },
    { id: 'grocer', title: '杂货铺掌柜', sign: '杂', shop: '杂货铺', stain: '一小块撕不干净的价签', items: [['一包火柴', 3], ['一斤菜油', 28], ['一包红糖', 11]] },
    { id: 'ferry', title: '船夫', sign: '渡', shop: '渡口', stain: '一圈被河水泡过的皱褶', items: [['过一趟河', 5], ['包一天船', 60]] },
    { id: 'weaver', title: '织工', sign: '布', shop: '织坊', stain: '一根蓝色的棉线', items: [['一匹土布', 95], ['一条围巾', 30]] },
  ];

  const SURNAMES = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何林罗高梁郑谢宋唐许韩冯邓曹彭曾田董潘袁蔡蒋余杜叶程魏苏吕丁沈姚卢姜崔钟谭陆汪范金石廖贾夏方白邹孟秦江尹薛段雷侯龙陶黎顾毛邵钱严'.split('');
  const GIVEN = ('小满 春生 秀兰 建国 桂芳 阿福 明远 晓梅 大川 素云 长庚 玉珍 德顺 冬青 海棠 守义 秋菊 来喜 金宝 根生 翠萍 有才 立夏 ' +
    '永福 松年 志刚 美娟 三水 六斤 二牛 文彬 丽华 国庆 红梅 卫东 小芸 家宝 青禾 远山 星河 一苇 知秋 南枝 半夏 白露 清明 ' +
    '谷雨 寒生 望舒 若水 听澜 麦冬 石头 阿娟 阿贵 宝根 喜旺 福生 满仓 杏儿 桃生 槐生 竹青 柏舟 小雨 安然 招财 铁柱').split(' ');
  const TOWN_NAMES = '青石 柳岸 槐花 桃溪 白鹭 梧桐 杏林 枫桥 月湾 芦苇 荷塘 松风 竹溪 云水 麦田 稻香 鹤鸣 金沙 落霞 石板 双桥 柿子'.split(' ');
  const SERIAL_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

  // 没有职业特色的痕迹，每样最多出现一次。都以钞票为主语来写，{n} 换成当时的持有人。
  const GENERIC_MARKS = [
    '被{n}在右上角用铅笔记了一串电话号码',
    '被{n}对折了四次，留下一道十字折痕',
    '背面多了{n}用圆珠笔算的一笔账',
    '被{n}家的小孩折成纸船，又小心地展开压平',
    '被{n}对着太阳照了照水印',
    '跟着{n}的衣服在洗衣盆里泡了一回',
    '空白处多了{n}画的一只歪歪扭扭的小猫',
    '被{n}拿去垫了一回桌脚',
  ];

  // 镇子的骨架：一条正街，两条巷子，外乡人从西边的官道进来。
  const STREETS = {
    main: { y: 318, x1: 0, x2: MAP_W, name: '正街' },
    lanes: [
      { x: 340, y1: 40, y2: 590, name: '西巷' },
      { x: 650, y1: 40, y2: 590, name: '东巷' },
    ],
  };
  const LOT_COLS = [90, 190, 285, 395, 490, 585, 715, 815, 910];
  const LOT_ROWS = [
    { y: 115, weight: 1 },
    { y: 235, weight: 3 },
    { y: 400, weight: 3 },
    { y: 515, weight: 1 },
  ];
  const INN_LOT = { x: 90, y: 235 };

  // ---------- 生成小镇 ----------

  function makeSerial(rng) {
    let digits = '';
    for (let i = 0; i < 8; i++) digits += rng.int(0, 9);
    return rng.pick(SERIAL_LETTERS) + rng.pick(SERIAL_LETTERS) + ' ' + digits + ' ' + rng.pick(SERIAL_LETTERS);
  }

  function pickLots(rng, count) {
    const lots = [];
    for (const row of LOT_ROWS) {
      for (const x of LOT_COLS) {
        if (x === INN_LOT.x && row.y === INN_LOT.y) continue;
        lots.push({ x, y: row.y, weight: row.weight });
      }
    }
    const chosen = [];
    while (chosen.length < count) {
      let total = 0;
      for (const lot of lots) total += lot.weight;
      let r = rng() * total;
      let idx = 0;
      while (r >= lots[idx].weight) {
        r -= lots[idx].weight;
        idx++;
      }
      chosen.push(lots.splice(idx, 1)[0]);
    }
    return chosen;
  }

  function thriftLabel(thrift) {
    if (thrift < 0.3) return '大手大脚';
    if (thrift < 0.6) return '量入为出';
    if (thrift < 0.85) return '精打细算';
    return '一分钱掰两半花';
  }

  function createTown(seed, opts) {
    opts = opts || {};
    const rng = makeRng('town|' + seed);
    const size = Math.max(6, Math.min(TRADES.length, opts.size || 20));
    const trades = [TRADES[0]].concat(rng.shuffle(TRADES.slice(1)).slice(0, size - 1));
    const lots = [INN_LOT].concat(pickLots(rng, size - 1));
    const usedNames = new Set();

    const residents = trades.map((trade, id) => {
      let name;
      do name = rng.pick(SURNAMES) + rng.pick(GIVEN);
      while (usedNames.has(name));
      usedNames.add(name);
      const lot = lots[id];
      const thrift = Math.round(rng() * 100) / 100;
      return {
        id,
        name,
        trade,
        x: lot.x + (id === 0 ? 0 : rng.int(-12, 12)),
        y: lot.y + (id === 0 ? 0 : rng.int(-8, 8)),
        cash: rng.chance(0.3) ? rng.int(0, 1) * 5 : rng.int(2, 18) * 5,
        thrift,
        temper: thriftLabel(thrift),
        favorites: [],
      };
    });

    for (const r of residents) {
      const others = rng.shuffle(residents.filter((o) => o.id !== r.id).map((o) => o.id));
      r.favorites = others.slice(0, 3);
    }

    // 初始欠账：一条绕回客栈的债务环（寓言里那样），再撒上一些随手的欠账。
    const debts = [];
    const ring = [0].concat(rng.shuffle(residents.slice(1).map((r) => r.id)).slice(0, rng.int(4, 6)));
    for (let i = 0; i < ring.length; i++) {
      debts.push({ from: ring[i], to: ring[(i + 1) % ring.length], amount: rng.int(5, 12) * 10 });
    }
    const looseAmounts = [15, 20, 25, 30, 40, 45, 50, 60, 75, 80, 90, 100, 120, 150];
    const looseCount = Math.round(size * 1.1);
    for (let i = 0; i < looseCount; i++) {
      const from = rng.int(0, size - 1);
      let to = rng.int(0, size - 2);
      if (to >= from) to++;
      debts.push({ from, to, amount: rng.pick(looseAmounts) });
    }

    return {
      seed: String(seed),
      name: rng.pick(TOWN_NAMES) + '镇',
      serial: makeSerial(rng),
      residents,
      debts,
      ring,
      width: MAP_W,
      height: MAP_H,
      streets: STREETS,
    };
  }

  // ---------- 镇上的规矩 ----------
  //
  // createSim(seed, { rules: { creditCap: true, ... } }) 打开对应的规矩；不传 rules（或全关）时，
  // 一切和原版一字不差：同一个种子，同样的事件，连随机数都不多抽一次。
  const RULE_PARAMS = {
    // 赊账有度：一个人欠全镇的账加起来超过这个数，谁家都不肯再赊；兜里零钱够的，可以当场现买。
    creditCap: { cap: 200 },
    // 照顾生意：手头宽裕的人（别人欠自己的不比自己欠别人的少）常拿闲钱出门买东西，
    // 一半时候特意去欠债人家照顾生意；对方欠着自己的，先拿货抵账；收了现钱的人转手先还账。
    patronage: { rate: 0.6, reserve: 20, reserveThrift: 60, needyShare: 0.5 },
    // 以工抵债：欠了 200 块以上、手头不到 30 块、又一个礼拜没摸到钞票的人，
    // 每天早上有三成可能去最大的债主那里帮一天工，30 块工钱抵账。
    workoff: { threshold: 200, idleDays: 7, wage: 30, chance: 0.3, hour: 8 },
    // 三角债清理：逢七的集日，商会账房把绕成圈的欠账按圈上最小的一笔对冲掉。
    netting: { every: 7, hour: 12 },
    // 第二位外乡人：第 2 天早上又来一位外乡人，也付一张百元钞住一晚。
    secondTraveler: { bills: 2 },
  };
  const RULE_KEYS = Object.keys(RULE_PARAMS);

  function readRules(opts) {
    const r = (opts && opts.rules) || {};
    const bills = r.bills ? Math.max(1, Math.min(16, Math.floor(r.bills))) : r.secondTraveler ? RULE_PARAMS.secondTraveler.bills : 1;
    return {
      creditCap: r.creditCap ? RULE_PARAMS.creditCap : null,
      patronage: r.patronage ? RULE_PARAMS.patronage : null,
      workoff: r.workoff ? RULE_PARAMS.workoff : null,
      netting: r.netting ? RULE_PARAMS.netting : null,
      bills,
    };
  }

  // ---------- 模拟 ----------

  function createSim(seed, opts) {
    const town = createTown(seed, opts);
    const rng = makeRng('sim|' + seed);
    const rules = readRules(opts);
    const n = town.residents.length;
    const owe = [];
    for (let i = 0; i < n; i++) owe.push(new Array(n).fill(0));

    function adjust(a, b, delta) {
      owe[a][b] += delta;
      owe[b][a] -= delta;
    }
    for (const d of town.debts) adjust(d.from, d.to, d.amount);

    const people = town.residents.map((r) => ({ id: r.id, cash: r.cash, timesHeld: 0, hoursHeld: 0 }));

    // 镇上的每张百元钞。0 号是外乡人带来的那张，页面跟着的就是它；其余的只有开了“第二位外乡人”才有。
    // 后来几张的编号用单独的随机数抽，不打扰小镇和故事本身的随机数。
    const MULTI = rules.bills > 1;
    const serialRng = MULTI ? makeRng('notes|' + seed) : null;
    const notes = [];
    for (let j = 0; j < rules.bills; j++) {
      let serial = town.serial;
      while (j > 0 && notes.some((x) => x.serial === serial)) serial = makeSerial(serialRng);
      notes.push({
        id: j,
        serial,
        holder: -1, // -1：钞票还在外乡人兜里
        arriveDay: 1 + j, // 第 j 位外乡人第 j+1 天早上进镇
        wear: 0,
        marks: [],
        path: [],
        heldFor: 0,
        movedToday: false,
        idleDays: 0,
        usedStains: new Set(),
        usedGeneric: new Set(),
        stats: {
          hands: 0,
          holders: new Set(),
          debtRepaid: 0,
          commerce: 0,
          iouCreated: 0,
          forgiven: 0,
          idleHours: 0,
          longestHold: { id: -1, hours: 0 },
        },
      });
    }
    // 每个人上一次拿到（任何一张）钞票的钟点，以工抵债要用
    const lastTouch = rules.workoff ? new Array(n).fill(DAY_START) : null;

    const state = {
      hour: DAY_START, // 从第 1 天 07:00 开始；hour 是自第 1 天 0 点起的小时数
      owe,
      people,
      bill: notes[0], // 页面跟着的那张
      bills: notes,
      stats: notes[0].stats,
      ruleStats: {
        refused: 0, // 赊账被拒的次数
        refusedCash: 0, // 被拒后当场现买的钱
        patronage: 0, // 照顾生意的买卖总额
        patronageNeedy: 0, // 其中特意去欠债人家买的
        passedOn: 0, // 收了现钱转手还账的钱
        workdays: 0,
        workedOff: 0, // 以工抵掉的欠账
        clearings: 0, // 开过几回清账
        cleared: 0, // 清账勾销掉的欠账
      },
      moneyIn: 0, // 外乡人留在镇上的钱：每张钞票的面值减去找走的零钱
      grossDebt: [],
      initialGross: 0,
    };
    // state.holder / heldFor / movedToday / idleDays 指 0 号钞票。
    for (const key of ['holder', 'heldFor', 'movedToday', 'idleDays']) {
      Object.defineProperty(state, key, {
        enumerable: true,
        get: () => notes[0][key],
        set: (v) => {
          notes[0][key] = v;
        },
      });
    }
    state.initialGross = grossDebt();
    state.grossDebt.push({ hour: state.hour, value: state.initialGross });

    function grossDebt() {
      let total = 0;
      for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) if (owe[a][b] > 0) total += owe[a][b];
      return total;
    }

    function debtEdges() {
      const edges = [];
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) if (owe[a][b] > 0) edges.push({ from: a, to: b, amount: owe[a][b] });
      }
      return edges;
    }

    function biggestCreditor(a) {
      let who = -1;
      let most = 0;
      for (let b = 0; b < n; b++) {
        if (owe[a][b] > most) {
          most = owe[a][b];
          who = b;
        }
      }
      return who;
    }

    // a 欠别人的总数
    function payables(a) {
      let total = 0;
      for (let b = 0; b < n; b++) if (owe[a][b] > 0) total += owe[a][b];
      return total;
    }

    // a 净欠多少：欠别人的减去别人欠自己的
    function netDebt(a) {
      let total = 0;
      for (let b = 0; b < n; b++) total += owe[a][b];
      return total;
    }

    function moveCash(from, to, amount) {
      people[from].cash -= amount;
      people[to].cash += amount;
    }

    // 只有一张钞票时事件不带 bill 字段，和原版一字不差。
    function tag(ev, note) {
      if (MULTI) ev.bill = note.id;
      return ev;
    }

    function holdsNote(id) {
      for (const note of notes) if (note.holder === id) return true;
      return false;
    }

    function maybeMark(note, who, events) {
      if (!rng.chance(0.08)) return;
      const r = town.residents[who];
      let text = null;
      if (!note.usedStains.has(r.trade.id) && rng.chance(0.6)) {
        note.usedStains.add(r.trade.id);
        text = '沾上了' + r.trade.shop + '的' + r.trade.stain;
      } else {
        const left = GENERIC_MARKS.filter((m) => !note.usedGeneric.has(m));
        if (!left.length) return;
        const tpl = rng.pick(left);
        note.usedGeneric.add(tpl);
        text = tpl;
      }
      const mark = { hour: state.hour, who, text };
      note.marks.push(mark);
      note.wear += 2;
      events.push(tag({ type: 'mark', hour: state.hour, who, text }, note));
    }

    function moveBill(note, from, to, events) {
      const st = note.stats;
      note.holder = to;
      note.movedToday = true;
      note.idleDays = 0;
      if (from >= 0 && note.heldFor > st.longestHold.hours) {
        st.longestHold = { id: from, hours: note.heldFor };
      }
      note.heldFor = 0;
      st.hands++;
      st.holders.add(to);
      people[to].timesHeld++;
      if (lastTouch) lastTouch[to] = state.hour;
      note.wear += rng.int(1, 3) / 10; // 每过一次手磨损一点点
      note.path.push({ hour: state.hour, from, to });
      maybeMark(note, to, events);
    }

    // 零钱不够找时，付钱的人从对方铺子里挑几样东西凑数：从贵到便宜，每样最多一份，最多三样。
    function roundUp(b, left) {
      const items = town.residents[b].trade.items.slice().sort((x, y) => y[1] - x[1]);
      const picked = [];
      for (const it of items) {
        if (left <= SMALL_CHANGE || picked.length >= 3) break;
        if (it[1] <= left) {
          picked.push({ item: it[0], price: it[1] });
          left -= it[1];
        }
      }
      return { picked, left };
    }

    // a 拿整钞付给 b 的话，最后会剩多少找不开、只能让 b 打欠条。
    function shortfall(a, b) {
      const owed = owe[a][b];
      if (owed >= BILL) return 0;
      const due = BILL - owed;
      const left = roundUp(b, due - Math.min(people[b].cash, due)).left;
      return left <= SMALL_CHANGE ? 0 : left;
    }

    // 付钱的人把整张钞票交出去后，收钱的人找零：
    // 先拿零钱找；零钱不够，付钱的人就再挑几样东西凑数；剩下的零头太小就算了，否则收钱的人打欠条。
    function makeChange(a, b, due) {
      const result = { change: 0, extras: [], forgiven: 0, iou: 0 };
      result.change = Math.min(people[b].cash, due);
      moveCash(b, a, result.change);
      adjust(a, b, result.change);
      const plan = roundUp(b, due - result.change);
      result.extras = plan.picked;
      for (const x of plan.picked) adjust(a, b, x.price);
      let left = plan.left;
      if (left > 0 && left <= SMALL_CHANGE) {
        result.forgiven = left;
        adjust(a, b, left);
        left = 0;
      }
      result.iou = left; // 此时 owe[b][a] === left
      return result;
    }

    function payWithBill(note, a, b, events, base) {
      const st = note.stats;
      const owed = owe[a][b];
      moveBill(note, a, b, events);
      adjust(a, b, -BILL);
      const ev = Object.assign(base, {
        hour: state.hour,
        from: a,
        to: b,
        owed,
        change: 0,
        extras: [],
        forgiven: 0,
        iou: 0,
        cashTopUp: 0,
        remaining: 0,
      });
      if (owed < BILL) {
        Object.assign(ev, makeChange(a, b, BILL - owed));
      } else if (owe[a][b] > 0 && ev.type === 'buy' && people[a].cash > 0) {
        ev.cashTopUp = Math.min(people[a].cash, owe[a][b]);
        moveCash(a, b, ev.cashTopUp);
        adjust(a, b, -ev.cashTopUp);
      }
      ev.remaining = Math.max(0, owe[a][b]);
      ev.extras.forEach((x) => (st.commerce += x.price));
      st.iouCreated += ev.iou;
      st.forgiven += ev.forgiven;
      events.push(tag(ev, note));
      return ev;
    }

    // 欠谁的钱先还谁：挑欠得最多、又找得开的那一家。都找不开的话，多半先等等。
    function chooseCreditor(a) {
      const creditors = [];
      for (let b = 0; b < n; b++) if (owe[a][b] > 0) creditors.push(b);
      if (!creditors.length) return -1;
      creditors.sort((x, y) => owe[a][y] - owe[a][x] || x - y);
      for (const b of creditors) if (shortfall(a, b) === 0) return b;
      return rng.chance(0.25) ? creditors[0] : -2;
    }

    // 持有人拿着一张钞票拿主意；手里有几张，每张各拿一次主意。
    function holderActs(note, events) {
      const h = note.holder;
      const me = town.residents[h];
      if (biggestCreditor(h) >= 0) {
        if (!rng.chance(0.25 + 0.5 * (1 - me.thrift))) return false;
        const creditor = chooseCreditor(h);
        if (creditor === -2) return tryBuy(note, h, events, true); // 都找不开，先去买点东西把整钞破开
        if (creditor < 0) return false;
        const owed = owe[h][creditor];
        // 零钱够的话，精打细算的人舍不得破开整钞，谁也不会为几块钱的小账破开它。
        if (owed < BILL && people[h].cash >= owed && (me.thrift > 0.6 || owed <= 20)) {
          moveCash(h, creditor, owed);
          adjust(h, creditor, -owed);
          events.push(tag({ type: 'payCash', hour: state.hour, from: h, to: creditor, amount: owed }, note));
          return false;
        }
        const ev = payWithBill(note, h, creditor, events, { type: 'repay' });
        note.stats.debtRepaid += Math.min(ev.owed, BILL);
        return true;
      }
      if (!rng.chance(0.08 + 0.3 * (1 - me.thrift))) return false;
      return tryBuy(note, h, events, false);
    }

    // 想买点东西：先在常去的几家里挑一家找得开的；都找不开，多半就不买了。
    function tryBuy(note, h, events, breaking) {
      const me = town.residents[h];
      const shops = rng.chance(0.75) ? rng.shuffle(me.favorites) : [pickOther(h)];
      let choice = null;
      for (const shop of shops) {
        const it = rng.pick(town.residents[shop].trade.items);
        if (owe[h][shop] + it[1] <= 0) continue; // 对方本来就欠着这么多，记账抵掉就行，用不着钞票
        adjust(h, shop, it[1]);
        const ok = shortfall(h, shop) === 0;
        adjust(h, shop, -it[1]);
        if (!choice) choice = { shop, it, risky: true };
        if (ok) {
          choice = { shop, it, risky: false };
          break;
        }
      }
      if (!choice || (choice.risky && !rng.chance(0.3))) return false;
      adjust(h, choice.shop, choice.it[1]);
      note.stats.commerce += choice.it[1];
      payWithBill(note, h, choice.shop, events, { type: 'buy', item: choice.it[0], price: choice.it[1], breaking });
      return true;
    }

    function pickOther(a) {
      let b = rng.int(0, n - 2);
      if (b >= a) b++;
      return b;
    }

    // 赊账。开了“赊账有度”，欠得太多的人就赊不到；零钱够的可以当场现买。
    function credit(buyer, shop, it, events) {
      const price = it[1];
      const before = owe[buyer][shop];
      if (rules.creditCap && before + price > 0) {
        const after = payables(buyer) - Math.max(0, before) + (before + price);
        if (after > rules.creditCap.cap) {
          const ev = { type: 'refused', hour: state.hour, from: buyer, to: shop, item: it[0], price, total: payables(buyer), paid: 0 };
          if (people[buyer].cash >= price) {
            moveCash(buyer, shop, price); // 现买：一手交钱一手交货
            ev.paid = price;
            state.ruleStats.refusedCash += price;
          }
          state.ruleStats.refused++;
          events.push(ev);
          return;
        }
      }
      adjust(buyer, shop, price);
      events.push({ type: 'credit', hour: state.hour, from: buyer, to: shop, item: it[0], price });
    }

    // 钞票之外，镇上也在过日子：有人赊账，有人拿零钱还账。手里攥着整钞的人不在此列。
    function townLife(events) {
      if (rng.chance(0.07)) {
        const buyer = rng.int(0, n - 1);
        if (!holdsNote(buyer)) {
          const shop = rng.pick(town.residents[buyer].favorites);
          const it = rng.pick(town.residents[shop].trade.items);
          credit(buyer, shop, it, events);
        }
      }
      if (rng.chance(0.08)) {
        const payer = rng.int(0, n - 1);
        const creditor = biggestCreditor(payer);
        if (!holdsNote(payer) && creditor >= 0 && people[payer].cash > 0) {
          const amount = Math.min(people[payer].cash, owe[payer][creditor]);
          moveCash(payer, creditor, amount);
          adjust(payer, creditor, -amount);
          events.push({ type: 'payCash', hour: state.hour, from: payer, to: creditor, amount, background: true });
        }
      }
    }

    // ----- 照顾生意 -----

    // 镇上谁手头紧，大家心里有数：按净欠多少挑一家，欠得越多越常被照顾。
    function pickNeedy(buyer) {
      const weights = [];
      let total = 0;
      for (let i = 0; i < n; i++) {
        const w = i === buyer ? 0 : Math.max(0, netDebt(i));
        weights.push(w);
        total += w;
      }
      if (total <= 0) return -1;
      let r = rng() * total;
      for (let i = 0; i < n; i++) {
        if (weights[i] > 0 && r < weights[i]) return i;
        r -= weights[i];
      }
      for (let i = n - 1; i >= 0; i--) if (weights[i] > 0) return i;
      return -1;
    }

    // 手头宽裕的人拿闲钱出门买点东西。
    function goShopping(events) {
      const P = rules.patronage;
      if (!rng.chance(P.rate)) return;
      const buyer = rng.int(0, n - 1);
      if (holdsNote(buyer) || netDebt(buyer) > 0) return;
      const me = town.residents[buyer];
      const spare = people[buyer].cash - (P.reserve + Math.round(P.reserveThrift * me.thrift));
      if (spare <= 0) return;
      let shop = -1;
      let needy = false;
      if (rng.chance(P.needyShare)) {
        shop = pickNeedy(buyer);
        needy = shop >= 0;
      }
      if (shop < 0) shop = rng.pick(me.favorites);
      const owedToMe = Math.max(0, owe[shop][buyer]);
      const items = town.residents[shop].trade.items.filter((it) => it[1] - Math.min(it[1], owedToMe) <= spare);
      if (!items.length) return;
      const it = rng.pick(items);
      const offset = Math.min(it[1], owedToMe); // 对方欠着自己的，先拿货抵账
      const cash = it[1] - offset;
      adjust(buyer, shop, offset);
      moveCash(buyer, shop, cash);
      state.ruleStats.patronage += it[1];
      if (needy) state.ruleStats.patronageNeedy += it[1];
      events.push({ type: 'cashBuy', hour: state.hour, from: buyer, to: shop, item: it[0], price: it[1], cash, offset, needy });
      // 收了现钱、自己又欠着债的人，转手就还给欠得最多的那家
      const creditor = cash > 0 ? biggestCreditor(shop) : -1;
      if (creditor >= 0) {
        const amount = Math.min(cash, people[shop].cash, owe[shop][creditor]);
        moveCash(shop, creditor, amount);
        adjust(shop, creditor, -amount);
        state.ruleStats.passedOn += amount;
        events.push({ type: 'payCash', hour: state.hour, from: shop, to: creditor, amount, background: true, fromSale: true });
      }
    }

    // ----- 以工抵债 -----

    // 欠了一身债、手头没钱、又好些天没摸到钞票的人，去最大的债主那里帮一天工，工钱直接抵账。
    // 这等于债主花工钱买了一天的活：身家从债主挪到帮工的人。
    function workOff(events) {
      const W = rules.workoff;
      for (let i = 0; i < n; i++) {
        if (holdsNote(i) || people[i].cash >= W.wage) continue;
        if (payables(i) < W.threshold) continue;
        const days = Math.floor((state.hour - lastTouch[i]) / 24);
        if (days < W.idleDays || !rng.chance(W.chance)) continue;
        const boss = biggestCreditor(i);
        const owed = owe[i][boss];
        const amount = Math.min(owed, W.wage);
        adjust(i, boss, -amount);
        state.ruleStats.workdays++;
        state.ruleStats.workedOff += amount;
        events.push({ type: 'workoff', hour: state.hour, from: i, to: boss, amount, owed, remaining: owe[i][boss], days });
      }
    }

    // ----- 三角债清理 -----

    // 从 s 出发、只经过编号比 s 大的人、再回到 s 的最短欠账圈（广度优先，邻居按编号从小到大）。
    function cycleThrough(s) {
      const prev = new Array(n).fill(-1);
      const seen = new Array(n).fill(false);
      seen[s] = true;
      let frontier = [s];
      while (frontier.length) {
        const next = [];
        for (const a of frontier) {
          for (let b = 0; b < n; b++) {
            if (owe[a][b] <= 0) continue;
            if (b === s) {
              const cycle = [];
              for (let v = a; v !== s; v = prev[v]) cycle.push(v);
              cycle.push(s);
              return cycle.reverse(); // [s, …, a]：每个人欠下一个人，a 欠 s
            }
            if (b < s || seen[b]) continue;
            seen[b] = true;
            prev[b] = a;
            next.push(b);
          }
        }
        frontier = next;
      }
      return null;
    }

    // 一圈人里谁也不用掏钱：每个人欠出去的和别人欠自己的同时少掉同一个数，身家都不变。
    function clearCycles(events) {
      const cycles = [];
      let cancelled = 0;
      for (let s = 0; s < n; s++) {
        for (let cycle = cycleThrough(s); cycle; cycle = cycleThrough(s)) {
          let amount = Infinity;
          for (let k = 0; k < cycle.length; k++) amount = Math.min(amount, owe[cycle[k]][cycle[(k + 1) % cycle.length]]);
          for (let k = 0; k < cycle.length; k++) adjust(cycle[k], cycle[(k + 1) % cycle.length], -amount);
          cycles.push({ members: cycle, amount });
          cancelled += amount * cycle.length;
        }
      }
      state.ruleStats.clearings++;
      state.ruleStats.cleared += cancelled;
      events.push({ type: 'clearing', hour: state.hour, cycles, cancelled });
    }

    function arrive(note, events) {
      const inn = 0;
      const at = events.length; // 'arrive' 排在这张钞票自己的痕迹事件前面
      moveBill(note, -1, inn, events);
      const change = Math.min(people[inn].cash, BILL - ROOM_PRICE);
      people[inn].cash -= change; // 找给外乡人的零钱跟着外乡人离开小镇
      note.stats.commerce += ROOM_PRICE;
      const ev = { type: 'arrive', hour: state.hour, to: inn, price: ROOM_PRICE, change, short: BILL - ROOM_PRICE - change };
      if (MULTI) {
        ev.bill = note.id;
        ev.serial = note.serial;
      }
      events.splice(at, 0, ev);
      note.arrivalChange = change;
      state.moneyIn += BILL - change;
      if (note.id === 0) state.arrivalChange = change;
    }

    function step() {
      state.hour++;
      const events = [];
      const hh = state.hour % 24;
      if (hh < DAY_START || hh >= DAY_END) {
        for (const note of notes) {
          if (note.holder >= 0) people[note.holder].hoursHeld++;
          note.heldFor++;
        }
        return events;
      }
      if (hh === DAY_START) {
        events.push({ type: 'dawn', hour: state.hour, day: dayOf(state.hour) });
        for (const note of notes) note.movedToday = false;
      }
      let inTown = false;
      for (const note of notes) {
        if (note.holder < 0) {
          if (hh >= 8 && dayOf(state.hour) >= note.arriveDay) arrive(note, events);
        } else {
          inTown = true;
          people[note.holder].hoursHeld++;
          note.heldFor++;
          if (!holderActs(note, events)) note.stats.idleHours++;
        }
      }
      // 镇上的日常从外乡人进镇的下一个钟头开始，每小时一回，跟有几张钞票无关。
      if (inTown) {
        townLife(events);
        if (rules.patronage) goShopping(events);
        if (rules.workoff && hh === rules.workoff.hour) workOff(events);
      }
      if (rules.netting && hh === rules.netting.hour && dayOf(state.hour) % rules.netting.every === 0) clearCycles(events);
      if (hh === DAY_END - 1) {
        for (const note of notes) {
          if (note.holder >= 0 && !note.movedToday) {
            note.idleDays++;
            events.push(tag({ type: 'idle', hour: state.hour, who: note.holder, days: note.idleDays }, note));
          }
        }
      }
      state.grossDebt.push({ hour: state.hour, value: grossDebt() });
      return events;
    }

    // 一直走到 0 号钞票换手（或者走满 limit 小时），返回这期间所有事件。
    function stepUntilMove(limit) {
      const all = [];
      const before = notes[0].stats.hands;
      for (let i = 0; i < (limit || 24 * 14); i++) {
        all.push.apply(all, step());
        if (notes[0].stats.hands !== before) break;
      }
      return all;
    }

    function totalMoney() {
      let total = 0;
      for (const p of people) total += p.cash;
      for (const note of notes) if (note.holder >= 0) total += BILL;
      return total;
    }

    // 某人手里攥着几张整钞
    function notesHeld(id) {
      let count = 0;
      for (const note of notes) if (note.holder === id) count++;
      return count;
    }

    return {
      town,
      state,
      rules,
      step,
      stepUntilMove,
      grossDebt,
      debtEdges,
      totalMoney,
      notesHeld,
      payables,
      netDebt,
      condition: (k) => Math.max(5, Math.round(100 - notes[k || 0].wear)),
    };
  }

  function dayOf(hour) {
    return Math.floor(hour / 24) + 1;
  }

  function clock(hour) {
    const hh = hour % 24;
    return '第 ' + dayOf(hour) + ' 天 ' + (hh < 10 ? '0' : '') + hh + ':00';
  }

  return {
    BILL,
    DAY_START,
    DAY_END,
    TRADES,
    makeRng,
    createTown,
    createSim,
    RULE_KEYS,
    RULE_PARAMS,
    thriftLabel,
    dayOf,
    clock,
  };
});
