/*
 * 百元漂流记 · 讲故事
 *
 * 把引擎吐出的事件翻成流水账里的一句句话。同一个事件永远翻成同一句话，
 * 句式的挑选只看事件本身，不用随机数，所以回放时故事一字不差。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Story = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BILL = 100;

  function yuan(n) {
    return n + ' 块';
  }

  function resident(town, id) {
    return town.residents[id];
  }

  // “面点师傅周小满”
  function who(town, id) {
    const r = resident(town, id);
    return r.trade.title + r.name;
  }

  // 钞票在这个人家里放在哪儿，看这个人有多抠。
  function place(r) {
    if (r.thrift < 0.3) return '衣兜';
    if (r.thrift < 0.6) return '抽屉';
    if (r.thrift < 0.85) return '钱匣子';
    return '枕头底下的铁皮饼干盒';
  }

  function list(extras) {
    return extras.map((x) => x.item).join('、');
  }

  // 从几个说法里挑一个：只看事件内容，保证可复现。
  function variant(ev, options) {
    const key = ev.hour * 31 + (ev.from || 0) * 7 + (ev.to || 0) * 13;
    return options[key % options.length];
  }

  function markText(mark, town) {
    return mark.text.replace('{n}', resident(town, mark.who).name);
  }

  // 整钞交出去之后怎么找零。due 是应找的数。
  function changeText(ev, town) {
    const a = resident(town, ev.from).name;
    const b = resident(town, ev.to).name;
    const due = BILL - ev.owed;
    if (ev.change === due) return b + '找回 ' + yuan(ev.change) + '零钱。';
    let s = ev.change > 0 ? b + '只找得出 ' + yuan(ev.change) + '零钱，' : b + '一时找不开，';
    const tail = [];
    if (ev.extras.length) tail.push(a + '索性又要了' + list(ev.extras) + '凑数');
    if (ev.forgiven) tail.push('差的 ' + yuan(ev.forgiven) + '零头，' + a + '摆摆手说不用找了');
    if (ev.iou) tail.push('剩下的 ' + yuan(ev.iou) + '，' + b + '给' + a + '写了张欠条');
    if (!tail.length) return s.replace(/，$/, '。');
    s += tail.join('；') + '。';
    return s;
  }

  function narrateRepay(ev, town) {
    const a = who(town, ev.from);
    const b = who(town, ev.to);
    if (ev.owed >= BILL) {
      const head = variant(ev, [
        a + '把钞票交给' + b + '，还上了欠的 ' + yuan(BILL) + '。',
        a + '揣着钞票去找' + b + '，先还上 ' + yuan(BILL) + '。',
        a + '用这张钞票还了欠' + b + '的 ' + yuan(BILL) + '。',
      ]);
      return head + (ev.remaining > 0 ? '还差 ' + yuan(ev.remaining) + '没还清。' : '这笔账总算两清。');
    }
    const head = variant(ev, [
      a + '拿这张钞票去还欠' + b + '的 ' + yuan(ev.owed) + '。',
      a + '想起还欠着' + b + ' ' + yuan(ev.owed) + '，把钞票递了过去。',
    ]);
    return head + changeText(ev, town);
  }

  function narrateBuy(ev, town) {
    const a = who(town, ev.from);
    const bR = resident(town, ev.to);
    const b = who(town, ev.to);
    const goods = ev.item + '（' + yuan(ev.price) + '）';
    let s;
    if (ev.breaking) {
      s = a + '欠的几笔账都找不开，便先去' + b + '的' + bR.trade.shop + '买了' + goods + '，好把整钞破开。';
    } else {
      s = variant(ev, [
        a + '到' + b + '的' + bR.trade.shop + '买了' + goods + '，付的正是这张百元钞。',
        a + '去' + bR.trade.shop + '找' + b + '要了' + goods + '，掏出了这张百元钞。',
        a + '在' + b + '那里买了' + goods + '，把百元钞拍在柜台上。',
      ]);
    }
    if (ev.owed < ev.price) s += '扣掉' + bR.name + '原先欠的 ' + yuan(ev.price - ev.owed) + '，';
    else if (ev.owed > ev.price) s += '连同之前赊的 ' + yuan(ev.owed - ev.price) + '一起结，';
    if (ev.owed < BILL) return s.replace(/，$/, '。') + changeText(ev, town);
    s = s.replace(/，$/, '。');
    if (ev.cashTopUp) s += '又添上 ' + yuan(ev.cashTopUp) + '零钱。';
    if (ev.remaining) s += '还有 ' + yuan(ev.remaining) + '先赊着。';
    return s;
  }

  function narrate(ev, sim) {
    const town = sim.town;
    switch (ev.type) {
      case 'dawn':
        return { kind: 'day', text: '第 ' + ev.day + ' 天' };
      case 'arrive': {
        const inn = who(town, ev.to);
        const innName = resident(town, ev.to).name;
        let s = '一个外乡人推开' + inn + '的门，把一张崭新的百元钞放在柜台上：“住一晚。”';
        if (ev.short === 0) s += innName + '收下钞票，找回 ' + yuan(ev.change) + '。';
        else if (ev.change > 0) s += innName + '翻遍钱匣只凑出 ' + yuan(ev.change) + '，剩下的 ' + yuan(ev.short) + '说好明早用一碗面抵。';
        else s += innName + '一时找不开，答应明早送一顿早饭抵那 ' + yuan(ev.short) + '。';
        return { kind: 'main', text: s + '这张钞票就这样留在了' + town.name + '。' };
      }
      case 'repay':
        return { kind: 'main', text: narrateRepay(ev, town) };
      case 'buy':
        return { kind: 'main', text: narrateBuy(ev, town) };
      case 'payCash': {
        const a = who(town, ev.from);
        const b = who(town, ev.to);
        if (ev.background) {
          return { kind: 'muted', text: a + '数出 ' + yuan(ev.amount) + '零钱，还了欠' + b + '的账。' };
        }
        const stingy = resident(town, ev.from).thrift > 0.6;
        return {
          kind: 'main',
          text: stingy
            ? a + '舍不得破开这张整钞，数出 ' + yuan(ev.amount) + '零钱还给了' + b + '。'
            : '这点小账犯不着破开整钞，' + a + '数出 ' + yuan(ev.amount) + '零钱还给了' + b + '。',
        };
      }
      case 'credit': {
        const bR = resident(town, ev.to);
        return {
          kind: 'muted',
          text: who(town, ev.from) + '在' + bR.trade.shop + '赊了' + ev.item + '（' + yuan(ev.price) + '）。',
        };
      }
      case 'idle': {
        const r = resident(town, ev.who);
        const spot = r.name + '的' + place(r);
        return {
          kind: 'main',
          text: ev.days > 1 ? '钞票在' + spot + '里已经躺了 ' + ev.days + ' 天。' : '钞票在' + spot + '里躺了一整天，哪儿也没去。',
        };
      }
      case 'mark':
        return { kind: 'mark', text: '钞票' + markText(ev, town) + '。' };
      default:
        return { kind: 'muted', text: '' };
    }
  }

  return { narrate, markText, who, place, yuan };
});
