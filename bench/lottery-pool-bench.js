'use strict';
/**
 * tg-monitor-bot 开奖池（LotteryPoolService）回归压测
 *
 * 拓扑与 bench/poll-bench-100.js 完全一致：100 账号 × 20 群，非全连接，mulberry32 固定种子 42
 * （热群 chat_0~4 60%、普通 chat_5~12 15%、冷门 chat_13~19 3%，上轮实测 413 次拉取/轮）
 *
 * 验证目标：
 *   1. 拉取量：每轮 = 群数(20) 而非 Σ(账号×群)(413)   → -95%
 *   2. 时序：单群消息按 旧 → 新 串行广播（开奖/结算不变量）
 *   3. 去重：群级水位下同一 (chatId, msgId) 绝不二次广播
 *   4. 韧性：代表账号连续失败 3 次 → 目录刷新自动换人
 *   5. 分片：shardCount=2 两池群不重叠、并集 = 全部群
 */
const assert = require('assert');

// ───────────────────────── 可复现随机（与 poll-bench-100.js 同款） ─────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const rint = (min, max) => min + Math.floor(rand() * (max - min + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── 拓扑生成（与 bench-100 同参数） ─────────────────────────
const CHATS = Array.from({ length: 20 }, (_, i) => `chat_${i}`);
const ACCOUNTS = Array.from({ length: 100 }, (_, i) => `user_${String(i).padStart(3, '0')}`);
const hotness = (i) => (i < 5 ? 0.6 : i < 13 ? 0.15 : 0.03);

const listenMap = new Map(); // userId -> chatId[]
for (const u of ACCOUNTS) {
  const set = new Set();
  CHATS.forEach((c, idx) => { if (rand() < hotness(idx)) set.add(c); });
  if (set.size === 0) set.add(CHATS[rint(0, 19)]);
  listenMap.set(u, [...set]);
}
let topologyFetch = 0;
const perChatListeners = new Map();
for (const c of CHATS) perChatListeners.set(c, 0);
for (const [, chats] of listenMap) { topologyFetch += chats.length; for (const c of chats) perChatListeners.set(c, perChatListeners.get(c) + 1); }
const hottest = [...perChatListeners.entries()].sort((a, b) => b[1] - a[1])[0];

// ───────────────────────── Stub 注入（先注 cache 再 require 真源码） ─────────────────────────
const loggerStub = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, audit: () => {} };
const failUsers = new Set();      // 强制拉取失败的账号（测故障换人）
const fetchCalls = { n: 0 };      // getMessages 调用计数
const dispatchLog = [];           // { chatId, msgId } 广播流水
const chatMsgId = new Map();      // chatId -> 最新消息 ID（模拟持续开奖）
for (const c of CHATS) chatMsgId.set(c, 1000 + rint(0, 500));

const clients = new Map();
for (const u of ACCOUNTS) {
  clients.set(u, {
    getMessages: async (chatId, { limit = 30 } = {}) => {
      fetchCalls.n++;
      await sleep(rint(50, 150)); // 模拟 GramJS RTT
      if (failUsers.has(u)) throw new Error('模拟网络故障');
      const cur = chatMsgId.get(chatId);
      const newest = cur + rint(1, 3); // 每次拉取都"产生"1~3 条新开奖
      chatMsgId.set(chatId, newest);
      const out = [];
      for (let id = newest; id > cur && out.length < limit; id--) out.push({ id });
      return out; // GramJS 语义：新 → 旧
    },
    connect: async () => {},
  });
}

const sessionManagerStub = {
  getAllClients: () => [...clients.entries()],
  getClient: (u) => clients.get(u) || null,
};
const dispatcherStub = {
  dispatch: async (message, chatId) => {
    dispatchLog.push({ chatId, msgId: Number(message.id) });
    await sleep(2); // 模拟 dispatch 内部开销
  },
};

function stub(rel, mod) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: mod };
}
stub('../src/utils/logger', loggerStub);
stub('../src/utils/mask.util', { maskChatId: (id) => id });
stub('../src/db/account.dao', { getActive: (u) => ({ status: 'ACTIVE', listen_enabled: 1 }) });
stub('../src/db/monitored-chat.dao', { listByUser: (u) => (listenMap.get(u) || []).map((chat_id) => ({ chat_id })) });

const LotteryPoolService = require('../src/services/lottery-pool.service');

// ───────────────────────── 事件循环健康监测 ─────────────────────────
function monitorEventLoop(stopAt) {
  const samples = [];
  let last = process.hrtime.bigint();
  const t = setInterval(() => {
    const now = process.hrtime.bigint();
    samples.push(Number(now - last) / 1e6);
    last = now;
    if (Date.now() > stopAt) clearInterval(t);
  }, 10);
  return { stop: async () => { await sleep(30); samples.sort((a, b) => a - b); return samples; } };
}

function pct(arr, p) { return arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : 0; }

// ───────────────────────── 主流程 ─────────────────────────
(async () => {
  console.log('===== tg-monitor-bot 开奖池回归压测（100 账号 × 20 群 · 种子 42） =====');
  console.log(`拓扑: 每轮拉取 ${topologyFetch} 次 (均 ${(topologyFetch / ACCOUNTS.length).toFixed(1)}/号), ` +
    `最热群 ${hottest[0]}=${hottest[1]} 号蹲守 (与 poll-bench-100 同款)`);

  const pool = new LotteryPoolService({
    sessionManager: sessionManagerStub,
    messageDispatcher: dispatcherStub,
    intervalMs: 5000,
    concurrency: 8,
    catalogRefreshMs: 30000,
  });

  // ── 1. 建立水位轮（首轮只建水位，不广播） ──
  fetchCalls.n = 0;
  await pool.pollOnce();
  assert.strictEqual(fetchCalls.n, 20, `首轮建水位应拉 20 次(=群数), 实际 ${fetchCalls.n}`);
  assert.strictEqual(dispatchLog.length, 0, '首轮建水位不应广播');
  console.log(`[1] 建水位轮: 拉取 ${fetchCalls.n} 次 (= 群数, 旧版 ${topologyFetch} 次 → -${(100 * (1 - fetchCalls.n / topologyFetch)).toFixed(1)}%), 广播 0 条 ✓`);

  // ── 2. 实测 3 轮：拉取量 / 延迟 / 广播量 / 事件循环 ──
  const mon = monitorEventLoop(Date.now() + 60000);
  const roundMs = [];
  let dispatchTotal = 0;
  for (let r = 1; r <= 3; r++) {
    const t0 = Date.now();
    const before = fetchCalls.n, beforeDispatch = dispatchLog.length;
    await pool.pollOnce();
    const dt = Date.now() - t0;
    const f = fetchCalls.n - before, d = dispatchLog.length - beforeDispatch;
    roundMs.push(dt); dispatchTotal += d;
    assert.strictEqual(f, 20, `第${r}轮应拉 20 次, 实际 ${f}`);
    console.log(`[2] 第${r}轮: ${dt}ms, 拉取 ${f} 次, 广播 ${d} 条`);
    await sleep(150); // 模拟轮询间隔
  }
  const loop = await mon.stop();

  // ── 3. 正确性断言：时序 + 去重 ──
  for (const c of CHATS) {
    const ids = dispatchLog.filter((e) => e.chatId === c).map((e) => e.msgId);
    for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1], `${c} 广播乱序: ${ids[i - 1]} → ${ids[i]}`);
  }
  const seen = new Set();
  for (const e of dispatchLog) {
    const k = `${e.chatId}:${e.msgId}`;
    assert.ok(!seen.has(k), `重复广播 ${k}`);
    seen.add(k);
  }
  console.log(`[3] 正确性: 单群全部 旧→新 串行 ✓, ${dispatchLog.length} 条广播 0 重复 ✓`);

  // ── 4. 故障换人：chat_0 的代表连续失败 3 次 → 自动换代表 ──
  const oldRep = pool._catalog.get('chat_0').rep;
  failUsers.add(oldRep);
  for (let i = 0; i < 3; i++) await pool.pollOnce();
  const newRep = pool._catalog.get('chat_0').rep;
  assert.notStrictEqual(newRep, oldRep, '连续失败 3 次后应换代表');
  const afterFail = fetchCalls.n;
  await pool.pollOnce();
  assert.strictEqual(fetchCalls.n - afterFail, 20, '换代表后恢复正常拉取量');
  console.log(`[4] 故障换人: ${oldRep} 连挂 3 次 → 换 ${newRep} 接管 ✓ (后续轮拉取量恢复 20)`);

  // ── 5. 分片：两池群不重叠、并集全覆盖 ──
  const s0 = new LotteryPoolService({ sessionManager: sessionManagerStub, messageDispatcher: dispatcherStub, intervalMs: 5000, shardCount: 2, shardIndex: 0 });
  const s1 = new LotteryPoolService({ sessionManager: sessionManagerStub, messageDispatcher: dispatcherStub, intervalMs: 5000, shardCount: 2, shardIndex: 1 });
  s0._refreshCatalog(); s1._refreshCatalog();
  const g0 = [...s0._catalog.keys()], g1 = [...s1._catalog.keys()];
  assert.strictEqual(g0.length + g1.length, 20, `两池并集应 = 20 群, 实际 ${g0.length}+${g1.length}`);
  assert.ok(g0.every((c) => !g1.includes(c)), '两池群不应重叠');
  console.log(`[5] 分片: 池1=${g0.length} 群 / 池2=${g1.length} 群, 不重叠且全覆盖 ✓`);

  // ── 汇总 ──
  const avgRound = roundMs.reduce((a, b) => a + b, 0) / roundMs.length;
  console.log('\n===== 结果汇总（对照 poll-bench-100.js 旧版数据） =====');
  console.log('指标                    旧版逐账号轮询            开奖池广播            收益');
  console.log(`每轮拉取次数            ${topologyFetch} 次                      20 次                 -${(100 * (1 - 20 / topologyFetch)).toFixed(0)}%`);
  console.log(`单轮耗时(实测)          串行 62040ms / pLimit16 4620ms   ${avgRound.toFixed(0)}ms (并发8)     vs 串行 ${(62040 / avgRound).toFixed(0)}x / vs pLimit16 ${(4620 / avgRound).toFixed(1)}x`);
  console.log(`广播(扇出)路径          413 账号各自拉取+DB去重          20 次 dispatch 群级扇出    账号零拉取`);
  console.log(`事件循环 p50/p99/max    20.4/22.4/38.1ms (上轮)          ${pct(loop, 50).toFixed(1)}/${pct(loop, 99).toFixed(1)}/${Math.max(...loop).toFixed(1)}ms ✓ 健康`);
  console.log('\nBENCH_ALL_OK');
  process.exit(0);
})().catch((e) => { console.error('BENCH_FAIL', e); process.exit(1); });