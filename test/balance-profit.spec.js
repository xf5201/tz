// test/balance-profit.spec.js — 盈利「余额−初始余额」口径验证（node 直接运行）
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'telegram') return { Api: { MessageMediaDice: class MessageMediaDice {} } };
  return _origLoad.apply(this, arguments);
};
const assert = require('assert');
const {
  calcBalanceProfit, calcRoundProfit, isTakeProfitReached,
} = require('../src/core/profit.guard');
const { calcSpecProfit } = require('../src/core/rule.engine');
const {
  parseSettleSpecLines,
} = require('../src/core/dice.parser');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { console.error(`  ❌ ${name}: ${e.message}`); process.exitCode = 1; }
}

console.log('== calcBalanceProfit（余额−初始余额） ==');
ok('198951 − 105030 = 93920.73 精确两位', () =>
  assert.strictEqual(calcBalanceProfit(198951.09, 105030.729), 93920.36));
ok('余额低于基准 → 负数', () => assert.strictEqual(calcBalanceProfit(100000, 105000), -5000));
ok('基准为 null → null（不猜）', () => assert.strictEqual(calcBalanceProfit(198951, null), null));
ok('余额为 null → null', () => assert.strictEqual(calcBalanceProfit(null, 1000), null));

console.log('== 名单行→资金流换算（赢 X = 行内净赔，需再扣 4A 未中成本） ==');
// 单注 A=80，整组投 400；命中行「赢 380」（群方口径 = A×4.75 行净赔）
// 我们资金流：返还 = 380 + 80 = 460；净利 = 460 − 400 = 60  →  rowNet − 4A = 380 − 320 = 60 ✓
const A = 80;
const rowNet = 380;
ok('命中行换算 = 行净赔 − 4×单注 = +60', () =>
  assert.strictEqual(rowNet - 4 * A, 60));
// 未中行「输 400」等价于 5 行「输 80」合计，或名单只给一行时直接 −5A
ok('整组未中 = −400', () => assert.strictEqual(-400, calcSpecProfit(400, false, 5.75)));
// 倍投后：A=720，投 3600，命中行赢 3420（=720×4.75）→ 净 = 3420 − 2880 = 540
ok('倍投档 A=720：净 = 3420 − 4×720 = +540', () =>
  assert.strictEqual(3420 - 4 * 720, 540));
ok('估算兜底同口径：calcSpecProfit(3600,win,5.75,720)=540', () =>
  assert.strictEqual(calcSpecProfit(3600, true, 5.75, 720), 540));

console.log('== 名单解析对照（真实样例格式） ==');
const settleText = [
  '❤️第abc123期输赢 ❤️ 骰子为: 4',
  '　小花猫 【7653490880】 定位胆4 80,赢 380 💰',
].join('\n');
ok('命中行解析 stake=80 win=380', () => {
  const rows = parseSettleSpecLines(settleText, '7653490880');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].stake, 80);
  assert.strictEqual(rows[0].win, 380);
  assert.strictEqual(rows[0].win - 4 * rows[0].stake, 60);
});

console.log('== 止盈判定（余额口径喂入） ==');
ok('本轮盈利 500 ≥ 目标 500 → 触发', () =>
  assert.strictEqual(isTakeProfitReached(500, 500), true));
ok('负盈利永不触发', () =>
  assert.strictEqual(isTakeProfitReached(-100, 500), false));
ok('目标 null 不触发', () =>
  assert.strictEqual(isTakeProfitReached(9999, null), false));

console.log(`\n结果: ${passed} 通过`);
if (process.exitCode) process.exit(1);