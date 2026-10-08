/*
 * 百元漂流记 · 长期实验
 *
 * 一次模拟几十座小镇各一整年，看全镇欠账（相对开局）怎么走。
 * 一座镇一座镇地跑，页面可以每跑几座就喘口气、更新进度，不会卡住。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.Lab = factory(root.Drift);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Drift) {
  'use strict';

  function quantile(sorted, p) {
    const i = (sorted.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  // daily[k][d]：第 k 座镇第 d+1 天收工后的欠账 ÷ 开局欠账
  function summarize(daily, days) {
    const p10 = [];
    const median = [];
    const p90 = [];
    for (let d = 0; d < days; d++) {
      const col = daily.map((row) => row[d]).sort((a, b) => a - b);
      p10.push(quantile(col, 0.1));
      median.push(quantile(col, 0.5));
      p90.push(quantile(col, 0.9));
    }
    const last = days - 1;
    const back = Math.min(90, last);
    return {
      days,
      towns: daily.length,
      p10,
      median,
      p90,
      final: median[last],
      low: Math.min.apply(null, median),
      lowDay: median.indexOf(Math.min.apply(null, median)) + 1,
      // 最后三个月，中位数平均每天变化多少（相对开局的比例）
      drift: back > 0 ? (median[last] - median[last - back]) / back : 0,
    };
  }

  // 同一个起始种子 + 同一套规矩，永远得到同一组小镇、同一条曲线。
  function createRun(options) {
    const towns = options.towns || 40;
    const days = options.days || 365;
    const rules = options.rules || null;
    const base = String(options.seed || 'lab');
    const daily = [];
    return {
      towns,
      days,
      get done() {
        return daily.length >= towns;
      },
      get progress() {
        return daily.length / towns;
      },
      // 跑下一座镇的一整年
      next() {
        if (daily.length >= towns) return false;
        const sim = Drift.createSim(base + '/' + daily.length, rules ? { rules } : undefined);
        const start = sim.state.initialGross || 1;
        const row = new Array(days);
        for (let d = 0; d < days; d++) {
          // 第 d+1 天 20:00 是最后一个做买卖的钟头，算完就是当天收工后的账
          const close = d * 24 + Drift.DAY_END - 1;
          while (sim.state.hour < close) sim.step();
          row[d] = sim.grossDebt() / start;
        }
        daily.push(row);
        return true;
      },
      result() {
        return daily.length ? summarize(daily, days) : null;
      },
    };
  }

  function runAll(options) {
    const run = createRun(options);
    while (run.next());
    return run.result();
  }

  return { createRun, runAll, summarize, quantile };
});
