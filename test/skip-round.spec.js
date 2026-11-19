// test/skip-round.spec.js — 定位胆「隔一把歇一把」节奏验证（node 直接运行）
// 无 node_modules：stub 掉 telegram / logger / 全部 DAO / connection（与 profit.spec.js 同套路）
const Module = require('module');
const assert = require('assert');

// ───────────────────────── stub 容器 ─────────────────────────
const calls = { inserts: [], simCredits: [], simDeducts: [], sentCount: 0, sendFail: false };
const states = new Map(); // `${ruleId}:${chatId}` → row（真字段名）

function stateKey(ruleId, chatId) { return `${ruleId}:${chatId}`; }
function defaultState(ruleId, chatId) {
  return {
    rule_id: ruleId, chat_id: String(chatId),
    consecutive_losses: 0, armed_direction: null, pending_direction: null,
    blocked: 0, blocked_reason: null, blocked_at: null, streak_broken: 0,
    skip_round: 0,
  };
}
function patchState(ruleId, chatId, patch) {
  const s = states.get(stateKey(ruleId, chatId)) || defaultState(ruleId, chatId);
  if (patch.blocked !== undefined) s.blocked = patch.blocked ? 1 : 0;
  if (patch.consecutiveLosses !== undefined) s.consecutive_losses = patch.consecutiveLosses;
  if (patch.armedDirection !== undefined) s.armed_direction = patch.armedDirection;
  if (patch.pendingDirection !== undefined) s.pending_direction = patch.pendingDirection;
  if (patch.streakBroken !== undefined) s.streak_broken = patch.streakBroken ? 1 : 0;
  if (patch.skipRound !== undefined) s.skip_round = patch.skipRound ? 1 : 0;
  states.set(stateKey(ruleId, chatId), s);
}

const ruleStateDaoStub = {
  ensure(ruleId, chatId) {
    const k = stateKey(ruleId, chatId);
    if (!states.has(k)) states.set(k, defaultState(ruleId, chatId));
    return { ...states.get(k) }; // 模拟 DB 行快照语义
  },
  updateState(ruleId, chatId, patch) { patchState(ruleId, chatId, patch); },
  consumeSkipRound(ruleId, chatId) {
    const s = ruleStateDaoStub.ensure(ruleId, chatId);
    if (Number(s.skip_round) === 1) { patchState(ruleId, chatId, { skipRound: 0 }); return true; }
    return false;
  },
  blockChat(ruleId, chatId, reason) {
    patchState(ruleId, chatId, { blocked: 1 });
    const s = states.get(stateKey(ruleId, chatId));
    s.blocked_reason = reason; s.armed_direction = null; s.pending_direction = null; s.skip_round = 0;
  },
  unblockChat(ruleId, chatId) {
    const s = ruleStateDaoStub.ensure(ruleId, chatId);
    if (s.blocked === 1) { patchState(ruleId, chatId, { blocked: 0, skipRound: 0 }); return true; }
    return false;
  },
  clearStaleArmed() { return false; },
  clearArmedByUser() { return 0; },
  listStalePending() { return []; },
};

let simAccount = {
  bot_user_id: 'U1', status: 'ACTIVE', simulate: 1, sim_balance: 1000000,
  balance: null, profit_stopped: 0, take_profit: null,
};
const accountDaoStub = {
  getActive: () => ({ ...simAccount }),
  deductSimBalance: (u, n) => calls.simDeducts.push(n),
  creditSimBalance: (u, n) => calls.simCredits.push(n),
};
let rulesForUser = [];
const ruleDaoStub = {
  listEnabledByUser: () => rulesForUser,
  getById: (id) => rulesForUser.find((r) => r.id === id) || null,
};
let recentValuesForChat = [];
const messageLogDaoStub = { recentValues: () => [...recentValuesForChat] };

let unsettledDryRow = null;
let unsettledSentRow = null;
const actionLogDaoStub = {
  insert(rec) { calls.inserts.push(rec); unsettledDryRow = rec.status === 'DRY_RUN'
    ? { ...rec, id: calls.inserts.length, settled_at: null } : null;
    return calls.inserts.length; },
  getLatestUnsettledDry: () => unsettledDryRow,
  getLatestUnsettledSent: () => unsettledSentRow,
  getRecentCreated: () => null,
  markSettled: () => { if (unsettledDryRow) { unsettledDryRow = null; return 1; }
    if (unsettledSentRow) { unsettledSentRow = null; return 1; } return 0; },
  sumProfit: () => 0,
  listSettledWinsByPeriod: () => [],
  getById: () => null,
  getByBetMsgId: () => null,
  markRejected: () => 1,
  updateRoundPeriodIfEmpty: () => {},
};

const operationLogDaoStub = { insert: () => {} };
const chatOddsDaoStub = { getOdds: () => null, getSpecOdds: () => null };
const txStub = { transaction: (fn) => fn(), getConnection: () => ({}) };
const loggerStub = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// ───────────────────────── 拦截 require ─────────────────────────
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'telegram') return { Api: { MessageMediaDice: class MessageMediaDice {} } };
  if (request === '../db/rule-state.dao') return ruleStateDaoStub;
  if (request === '../db/account.dao') return accountDaoStub;
  if (request === '../db/rule.dao') return ruleDaoStub;
  if (request === '../db/message-log.dao') return messageLogDaoStub;
  if (request === '../db/action-log.dao') return actionLogDaoStub;
  if (request === '../db/operation-log.dao') return operationLogDaoStub;
  if (request === '../db/chat-odds.dao') return chatOddsDaoStub;
  if (request === '../db/connection') return txStub;
  if (request === '../utils/logger') return loggerStub;
  return _origLoad.apply(this, arguments);
};

const { StrategyExecutorService, isBetWindowMessage } = require('../src/services/strategy-executor.service');

function freshExec(sendOk = true) {
  return new StrategyExecutorService({
    betSender: { async sendBetMessage() { calls.sentCount++; return sendOk; } },
    notification: null,
  });
}
function resetAll(specRule) {
  calls.inserts = []; calls.simCredits = []; calls.simDeducts = []; calls.sentCount = 0;
  calls.sendFail = false;
  states.clear(); unsettledDryRow = null; unsettledSentRow = null;
  simAccount = { ...simAccount, simulate: 1 };
  rulesForUser = [specRule];
}

// SPEC_FIVE 规则（与生产同构：base 10 / ratio 10，上限 6 连败）
const SPEC_RULE = {
  id: 4, name: '五数定位胆', mode: 1, base_bet: 10, martingale_ratio: 10,
  max_lose_streak: 6, stop_loss: null, min_interval: 0, streak_count: 1, enabled: 1,
};
const CLASSIC_RULE = {
  id: 5, name: '大小反买', mode: 0, base_bet: 100, martingale_ratio: 2,
  max_lose_streak: 6, stop_loss: null, min_interval: 0, streak_count: 2, enabled: 1,
};

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { console.error(`  ❌ ${name}: ${e.message}`); process.exitCode = 1; }
}
const st = (ruleId, chatId) => states.get(stateKey(ruleId, chatId)) || defaultState(ruleId, chatId);

(async () => {
  console.log('== SPEC_FIVE：下一把 → 歇一把 → 再下 ==');
  await (async () => {
    resetAll(SPEC_RULE);
    const ex = freshExec();
    const U = 'U1', C = 'C1';

    // t0 开奖 3 点 → 武装（取号含最新：3 + 补齐）
    recentValuesForChat = [3];
    const armedN = await ex.handleOpen(U, C, { value: 3, msgId: 'm1' });
    ok('t0 开奖后进入待发', () => assert.strictEqual(armedN, 1));
    ok('t0 未点亮隔把标记', () => assert.strictEqual(st(SPEC_RULE.id, C).skip_round, 0));

    // t1 开盘信号 → 下注（模拟），点亮 skip_round
    await ex.handleRoundOpen(U, C, '期号: abc001 🧧底注: 1u 下注格式…');
    ok('t1 已下注（1 条 action_log）', () => assert.strictEqual(calls.inserts.length, 1));
    ok('t1 isBetWindowMessage 识别开盘', () => assert.strictEqual(isBetWindowMessage('期号: abc001 🧧底注: 1u'), true));
    ok('t1 点亮隔把标记 skip_round=1', () => assert.strictEqual(st(SPEC_RULE.id, C).skip_round, 1));
    ok('t1 进入挂起等结算', () => assert.notStrictEqual(st(SPEC_RULE.id, C).pending_direction, null));
    ok('t1 模拟钱包扣整组 50', () => assert.deepStrictEqual(calls.simDeducts, [50]));

    // t2 开奖 5 点 → 结算上一注（1,2,3,4,5 命中）→ 本把应歇一把
    recentValuesForChat = [5, 3];
    const armed2 = await ex.handleOpen(U, C, { value: 5, msgId: 'm2' });
    ok('t2 结算掉了上一注', () => { assert.strictEqual(calls.inserts.length, 1); assert.strictEqual(unsettledDryRow, null); });
    ok('t2 本把没有武装（歇一把）', () => assert.strictEqual(armed2, 0));
    ok('t2 标记已消费清零', () => assert.strictEqual(st(SPEC_RULE.id, C).skip_round, 0));
    ok('t2 无第二笔下注', () => assert.strictEqual(calls.inserts.length, 1));

    // t3 开奖 2 点 → 恢复武装
    recentValuesForChat = [2, 5, 3];
    const armed3 = await ex.handleOpen(U, C, { value: 2, msgId: 'm3' });
    ok('t3 下一把恢复待发', () => assert.strictEqual(armed3, 1));
    ok('t3 标记保持 0', () => assert.strictEqual(st(SPEC_RULE.id, C).skip_round, 0));

    // t4 开盘 → 再次下注，标记再次点亮
    await ex.handleRoundOpen(U, C, '期号: abc002 🧧底注: 1u');
    ok('t4 恢复后正常下注（第 2 笔）', () => assert.strictEqual(calls.inserts.length, 2));
    ok('t4 标记再次点亮', () => assert.strictEqual(st(SPEC_RULE.id, C).skip_round, 1));
  })().catch((e) => { console.error('  ❌ 场景一异常:', e); process.exitCode = 1; });

  console.log('== CLASSIC（大小）不受隔把影响 ==');
  await (async () => {
    resetAll(CLASSIC_RULE);
    const ex = freshExec();
    const U = 'U1', C = 'C1';
    recentValuesForChat = [4, 4];
    await ex.handleOpen(U, C, { value: 4, msgId: 'm1' });
    await ex.handleRoundOpen(U, C, '期号: abc001 🧧底注: 1u');
    ok('大小玩法正常下注', () => assert.strictEqual(calls.inserts.length, 1));
    ok('大小玩法不点亮隔把标记', () => assert.strictEqual(st(CLASSIC_RULE.id, C).skip_round, 0));
  })().catch((e) => { console.error('  ❌ 场景二异常:', e); process.exitCode = 1; });

  console.log('== 实发发送失败：不算「下过一把」，标记撤销 ==');
  await (async () => {
    resetAll(SPEC_RULE);
    simAccount = { ...simAccount, simulate: 0 };
    const ex = freshExec(false); // sendBetMessage → false
    const U = 'U1', C = 'C1';
    recentValuesForChat = [3];
    await ex.handleOpen(U, C, { value: 3, msgId: 'm1' });
    await ex.handleRoundOpen(U, C, '期号: abc001 🧧底注: 1u');
    const s = st(SPEC_RULE.id, C);
    ok('发送失败挂起回滚', () => assert.strictEqual(s.pending_direction, null));
    ok('发送失败隔把标记一并撤销', () => assert.strictEqual(s.skip_round, 0));
  })().catch((e) => { console.error('  ❌ 场景三异常:', e); process.exitCode = 1; });

  console.log('== 停注群不破节奏：blocked 期间标记被 clear，恢复后照常隔把 ==');
  await (async () => {
    resetAll(SPEC_RULE);
    const U = 'U1', C = 'C1';
    // 造一个 blocked + skip_round=1 的脏状态
    patchState(SPEC_RULE.id, C, { blocked: 1, skipRound: 1 });
    const ex = freshExec();
    ruleStateDaoStub.unblockChat(SPEC_RULE.id, C);
    ok('解除停注时隔把标记同步清零', () => assert.strictEqual(st(SPEC_RULE.id, C).skip_round, 0));
  })().catch((e) => { console.error('  ❌ 场景四异常:', e); process.exitCode = 1; });

  console.log(`\n结果: ${passed} 通过`);
  if (process.exitCode) process.exit(1);
})();
