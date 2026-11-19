'use strict';
/**
 * tg-monitor-bot 轮询/分发并发压测（20 账号 × 5 群）
 *
 * 方法：
 *   - stub 掉 DAO/Logger（require.cache 注入），加载「真」DicePollerService 源码
 *   - mock TelegramClient.getMessages：RTT 100~200ms 随机，模拟真实网络
 *   - 对比四种调度策略的单轮耗时 + 同群开奖扇出 + 事件循环健康度
 */
const path = require('path');
const { Module } = require('module');
const { monitorEventLoopDelay } = require('perf_hooks');

const ROOT = '/root/tz';
const ACCOUNTS = 20;
const CHATS_PER = 5;

// ── 1. 注入 stub（必须在 require 真 poller 之前）──
const accountDao = {
  getActive: (id) => ({ bot_user_id: String(id), status: 'ACTIVE', listen_enabled: 1 }),
};
const monitoredChatDao = {
  listByUser: (id) =>
    Array.from({ length: CHATS_PER }, (_, i) => ({ chat_id: `chat_${id}_${i}` })),
};
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const maskChatId = (x) => String(x);
function stub(relPath, exports) {
  const f = require.resolve(path.join(ROOT, relPath));
  const m = new Module(f, null);
  m.filename = f;
  m.exports = exports;
  m.loaded = true;
  require.cache[f] = m;
}
stub('src/db/account.dao.js', accountDao);
stub('src/db/monitored-chat.dao.js', monitoredChatDao);
stub('src/utils/logger.js', logger);
stub('src/utils/mask.util.js', { maskChatId });

const DicePollerService = require(path.join(ROOT, 'src/services/dice-poller.service.js'));

// ── 2. mock：TG client / dispatcher ──
let globalMsgId = 500000;
let dispatched = 0;
let getMessagesCalls = 0;
function makeClient() {
  let call = 0;
  return {
    connect: async () => {},
    getMessages: (chatId /* , opts */) =>
      new Promise((res) => {
        const rtt = 100 + Math.random() * 100; // 100~200ms：真实 TG 网络体感
        setTimeout(() => {
          getMessagesCalls++;
          call++;
          const n = call === 1 ? 30 : 2; // 首轮建水位给满窗，稳态每群 2 条新消息
          const msgs = [];
          for (let i = 0; i < n; i++) msgs.push({ id: ++globalMsgId, message: 'bench' });
          res(msgs.reverse()); // GramJS 语义：新 → 旧
        }, rtt);
      }),
  };
}
const clients = new Map();
for (let u = 1; u <= ACCOUNTS; u++) clients.set(String(9000 + u), makeClient());
const mockSessionManager = { getAllClients: () => Array.from(clients.entries()) };
const mockDispatcher = { dispatch: async () => { dispatched++; } };
function makePoller() {
  return new DicePollerService({
    sessionManager: mockSessionManager,
    messageDispatcher: mockDispatcher,
    intervalMs: 1e9,
  });
}

// 零依赖 pLimit
function pLimit(n) {
  const q = [];
  let active = 0;
  const next = () => { active--; if (q.length) q.shift()(); };
  return (fn) =>
    new Promise((res, rej) => {
      const run = () => { active++; fn().then(res, rej).finally(next); };
      if (active < n) run();
      else q.push(run);
    });
}

// A. 原版串行（现网实现，真源码 pollOnce）
async function runSerial(poller) {
  await poller.pollOnce();
}
// B/C/D. 并行版：按账号并行、单账号内保持串行（Phase 1 方案，防同号 FLOOD_WAIT）
async function runParallel(poller, n) {
  const lim = pLimit(n);
  await Promise.allSettled(
    poller.sessionManager.getAllClients().map(([userId, client]) =>
      lim(async () => {
        const account = accountDao.getActive(userId);
        if (!account || account.status !== 'ACTIVE' || !account.listen_enabled) return;
        const chats = monitoredChatDao.listByUser(userId);
        for (const chat of chats) {
          try { await poller._pollChat(userId, client, chat.chat_id); } catch (_) {}
        }
      })
    )
  );
}

async function bench(name, fn, rounds) {
  const poller = makePoller();
  await fn(poller); // 热身：建水位
  const times = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    await fn(poller);
    times.push(performance.now() - t0);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(
    `${name.padEnd(30)} 单轮均值: ${(avg / 1000).toFixed(2)}s   明细: [${times
      .map((t) => (t / 1000).toFixed(2))
      .join(', ')}]s`
  );
  return avg;
}

(async () => {
  const el = monitorEventLoopDelay({ resolution: 20 });
  el.enable();
  console.log(
    `===== tg-monitor-bot 轮询压测: ${ACCOUNTS} 账号 x ${CHATS_PER} 群 = ${ACCOUNTS * CHATS_PER} 次拉取/轮 =====`
  );
  console.log('模拟 RTT: 100~200ms/次 (GramJS getMessages 真实网络体感)\n');

  const tSerial = await bench('A. 原版串行 (现网实现)', (p) => runSerial(p), 2);
  const tP4 = await bench('B. 并行 pLimit(4) [Phase1]', (p) => runParallel(p, 4), 3);
  const tP8 = await bench('C. 并行 pLimit(8)', (p) => runParallel(p, 8), 3);
  const tInf = await bench('D. 全并行 (无限制)', (p) => runParallel(p, 999), 3);

  // ── 同群开奖扇出：20 账号 ──
  const work = () => new Promise((r) => setTimeout(r, 20)); // mock 单次 handleOpen ≈ 20ms
  let t0 = performance.now();
  for (let i = 0; i < ACCOUNTS; i++) await work();
  const fanSerial = performance.now() - t0;
  t0 = performance.now();
  await Promise.allSettled(Array.from({ length: ACCOUNTS }, () => work()));
  const fanPar = performance.now() - t0;
  console.log(`\n----- 同群开奖扇出 (${ACCOUNTS} 账号, 单次 handleOpen≈20ms) -----`);
  console.log(
    `串行 for+await: ${fanSerial.toFixed(0)}ms    Promise.allSettled: ${fanPar.toFixed(0)}ms    加速 ${(fanSerial / fanPar).toFixed(1)}x`
  );

  el.disable();
  const pct = (x) => (el.percentile(x) / 1e6).toFixed(1);
  console.log('\n----- 事件循环健康度 (压测全程) -----');
  console.log(`loop lag p50=${pct(50)}ms  p99=${pct(99)}ms  max=${(el.max / 1e6).toFixed(1)}ms`);

  console.log('\n===== 结论 =====');
  console.log(
    `轮询: 串行 ${(tSerial / 1000).toFixed(1)}s -> pLimit4 ${(tP4 / 1000).toFixed(1)}s (${(tSerial / tP4).toFixed(1)}x) -> pLimit8 ${(tP8 / 1000).toFixed(1)}s (${(tSerial / tP8).toFixed(1)}x) -> 无限 ${(tInf / 1000).toFixed(1)}s (${(tSerial / tInf).toFixed(1)}x)`
  );
  console.log(`消息量: 每轮 ${ACCOUNTS * CHATS_PER} 次拉取; dispatch 累计 ${dispatched} 条(含热身); getMessages 总调用 ${getMessagesCalls}`);
  console.log(
    `5s 间隔判定: 串行${tSerial > 5000 ? ' 超间隔,跳轮' : ' 未超间隔'}; pLimit4 ${tP4 > 5000 ? ' 超间隔' : ' 未超间隔 ✓'}`
  );
})().catch((e) => {
  console.error('BENCH_FAIL', e);
  process.exit(1);
});
