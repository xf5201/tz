// test/profit.spec.js — 定位胆金额口径与取号口径验证（node 直接运行）
// 本地无 node_modules：stub 掉 dice.parser 依赖的 telegram（仅用 Api.MessageMediaDice 类型判断）
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'telegram') {
    return { Api: { MessageMediaDice: class MessageMediaDice {} } };
  }
  return _origLoad.apply(this, arguments);
};
const assert = require('assert');
const {
  NUMBERS_PER_BET, calcSpecProfit, pickNumbers, calcAmount, calcCumulativeStake,
} = require('../src/core/rule.engine');
const {
  parseSettleSpecLines, parseSettleSizeLines, parseSpecPayoutSamples,
} = require('../src/core/dice.parser');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { console.error(`  ❌ ${name}: ${e.message}`); process.exitCode = 1; }
}

console.log('== calcSpecProfit（P0-1 修复口径） ==');
ok('总投入50(每注10) 赢 → +8', () => assert.strictEqual(calcSpecProfit(50, true, 5.8), 8));
ok('总投入500(每注100) 赢 → +80', () => assert.strictEqual(calcSpecProfit(500, true, 5.8), 80));
ok('总投入5000(每注1000) 赢 → +800', () => assert.strictEqual(calcSpecProfit(5000, true, 5.8), 800));
ok('总投入50 输 → -50', () => assert.strictEqual(calcSpecProfit(50, false, 5.8), -50));
ok('总投入500 输 → -500', () => assert.strictEqual(calcSpecProfit(500, false, 5.8), -500));
ok('自定义倍率5.75：总投入50 赢 → +7.5', () => assert.strictEqual(calcSpecProfit(50, true, 5.75), 7.5));
ok('perNoteOverride=10 总投入100（旧行单注口径） 赢 → +8', () => assert.strictEqual(calcSpecProfit(100, true, 5.8, 10), 8));
ok('perNoteOverride=10 总投入100（旧行） 输 → -100', () => assert.strictEqual(calcSpecProfit(100, false, 5.8, 10), -100));
ok('NUMBERS_PER_BET === 5', () => assert.strictEqual(NUMBERS_PER_BET, 5));

console.log('== pickNumbers（含最新开奖） ==');
ok('含最新：新→旧 3,3,5,3,1 → 1,3,5 + 补齐 2,4', () =>
  assert.deepStrictEqual(pickNumbers([3, 3, 5, 3, 1]), [1, 2, 3, 4, 5]));
ok('含最新：新→旧 2,2,2,2,2 → 1,2,3,4,5', () =>
  assert.deepStrictEqual(pickNumbers([2, 2, 2, 2, 2]), [1, 2, 3, 4, 5]));
ok('含最新：新→旧 6,5,4,3,2,1 → 2,3,4,5,6（前5个不同，升序输出）', () =>
  assert.deepStrictEqual(pickNumbers([6, 5, 4, 3, 2, 1]), [2, 3, 4, 5, 6]));
ok('空历史 → 补齐 1..5', () =>
  assert.deepStrictEqual(pickNumbers([]), [1, 2, 3, 4, 5]));
ok('最新4：4,4,3 → 3,4 + 补 1,2,5', () =>
  assert.deepStrictEqual(pickNumbers([4, 4, 3]), [1, 2, 3, 4, 5]));

console.log('== calcCumulativeStake（总投入口径） ==');
ok('mode=1 base10 ratio10 losses2 → 50+500+5000=5550', () =>
  assert.strictEqual(calcCumulativeStake(10, 10, 2, 1), 5550));
ok('mode=1 losses0 → 50', () => assert.strictEqual(calcCumulativeStake(10, 10, 0, 1), 50));
ok('mode=0 base100 ratio2 losses1 → 300', () =>
  assert.strictEqual(calcCumulativeStake(100, 2, 1, 0), 300));
ok('calcAmount 与单注金额一致', () => assert.strictEqual(calcAmount(10, 10, 1), 100));

console.log('== parseSettleSpecLines / parseSettleSizeLines（行级归属） ==');
const sample = [
  '❤️第abc期输赢 ❤️ 骰子为: 6',
  '　奔驰 迈巴赫 【487246459】 定位胆6 10,赢 47.5 💰',
  '　小花 【487246459】 定位胆1 10,输 10',
  '　久遇 【8872785955】 大 300,赢 285 💰',
].join('\n');
ok('定位胆行：命中行+未中行各一条', () => {
  const rows = parseSettleSpecLines(sample, '487246459');
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[0], { number: 6, stake: 10, win: 47.5, lose: null });
  assert.deepStrictEqual(rows[1], { number: 1, stake: 10, win: null, lose: 10 });
});
ok('别人的行不匹配', () => assert.strictEqual(parseSettleSpecLines(sample, '111').length, 0));
ok('行级净盈亏 = 47.5 - 10 = 37.5', () => {
  const rows = parseSettleSpecLines(sample, '487246459');
  const total = rows.reduce((s, l) => s + (l.win != null ? l.win : -(l.lose || 0)), 0);
  assert.strictEqual(total, 37.5);
});
ok('大小行解析', () => {
  const rows = parseSettleSizeLines(sample, '8872785955');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].label, '大');
  assert.strictEqual(rows[0].win, 285);
});

console.log('== parseSpecPayoutSamples（群级倍率学习） ==');
const sample2 = [
  '❤️第abc期输赢 ❤️ 骰子为: 6',
  '　奔驰 【7016374749】 定位胆6 200,赢 950 💰',
  '　久遇 【8872785955】 大 300,赢 285 💰',
].join('\n');
ok('定位胆行 → (950+200)/200 = 5.75', () => {
  const s = parseSpecPayoutSamples(sample2);
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0], 5.75);
});
ok('大小行不混入定位胆倍率', () => {
  const s = parseSpecPayoutSamples('❤️第x期输赢 ❤️ 骰子为: 1\n　久遇 【1】 大 300,赢 285 💰');
  assert.strictEqual(s.length, 0);
});

console.log(`\n结果: ${passed} 通过`);
if (process.exitCode) process.exit(1);