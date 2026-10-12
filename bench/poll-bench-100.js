'use strict';
/**
 * tg-monitor-bot 轮询压测 · 大规模版（100 账号 × 20 群，非全连接拓扑）
 *
 * 拓扑（固定种子可复现）：
 *   - chat_0~4   热门共同群：60% 账号监听（模拟大家都蹲的开奖群）
 *   - chat_5~12  普通群：15% 账号监听
 *   - chat_13~19 冷门群：3% 账号监听（长尾专属群）
 * 对比：串行 / pLimit(4/8/16) / 全并行 / Phase2 分片模拟(4×25号,各pLimit8)
 */
const path = require('path');
const { Module } = require('module');
const { monitorEventLoopDelay } = require('perf_hooks');

const ROOT = '/root/tz';
const ACCOUNTS = 100;
const CHAT_POOL = 20;

// ── 0. 固定种子 RNG（mulberry32），拓扑可复现 ──
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(42);

// ── 1. 拓扑生成：非全连接，共同群重叠 + 长尾专属群 ──
const userChats = new Map(); // userId -> [chatId]
const chatListeners = new Array(CHAT_POOL).fill(0);
for (let u = 1; u <= ACCOUNTS; u++) {
  const uid = String(9000 + u);
  const set = new Set();
  for (let g = 0; g < CHAT_POOL; g++) {
    const p = g < 5 ? 0.6 : g < 13 ? 0.15 : 0.03;
    if (rnd() < p) set.add(`chat_${g}`);
  }
  if (set.size === 0) set.add(`chat_${Math.floor(rnd() * 5)}`); // 至少蹲 1 个群
  userChats.set(uid, [...set]);
  for (const c of set) chatListeners[Number(c.slice(5))]++;
}
const totalFetch = [...userChats.values()].reduce((a, b) => a + b.length, 0);
const avgPerAcc = totalFetch / ACCOUNTS;
const maxListeners = Math.max(...chatListeners);
const avgListeners = (totalFetch / CHAT_POOL).toFixed(1);

// ── 2. stub 注入（必须在 require 真 poller 之前）──
const accountDao = {
  getActive: (id) => ({ bot_user_id: String(id), status: 'ACTIVE', listen_enabled: 1 }),
};
const monitoredChatDao = {
  listByUser: (id) => (userChats.get(String(id)) || []).map((c) => ({ chat_id: c })),
};
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
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
stub('src/utils/mask.util.js', { maskChatId: (x) => String(x) });

const DicePollerService = require(path.join(ROOT, 'src/services/dice-poller.service.js'));

// ── 3. mock：TG client / dispatcher ──
let globalMsgId = 9000000;
let dispatched = 0;
let getMessagesCalls = 0;
function makeClient() {
  let call = 0;
  return {
    connect: async () => {},
    getMessages: (chatId /* , opts */) =>
      new Promise((res) => {
        const rtt = 100 + Math.random() * 100; // 100~200ms
        setTimeout(() => {
          getMessagesCalls++;
          call++;
          const n = call === 1 ? 30 : 2; // 首轮建水位满窗，稳态每群 2 条新消息
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

// 通用：单账号内串行跑完它的所有群（防同号 FLOOD_WAIT 护城河）
async function pollAccount(poller, userId, client) {
  const chats = monitoredChatDao.listByUser(userId);
  for (const chat of chats) {
    try { await poller._pollChat(userId, client, chat.chat_id); } catch (_) {}
  }
}

// A. 原版串行（真源码 pollOnce）
const runSerial = (p) => p.pollOnce();

// B~D. 按账号并行 + pLimit
function runParallel(poller, n) {
  const lim = pLimit(n);
  return Promise.allSettled(
    poller.sessionManager.getAllClients().map(([userId, client]) => lim(() => pollAccount(poller, userId, client)))
  );
}

// E. Phase2 分片模拟：shards 个"进程"各持一段账号，片内 pLimit(n)（模拟 4 进程真并行）
async function runSharded(poller, shards, n) {
  const entries = poller.sessionManager.getAllClients();
  const size = Math.ceil(entries.length / shards);
  const groups = [];
  for (let i = 0; i < entries.length; i += size) groups.push(entries.slice(i, i + size));
  await Promise.all(
    groups.map((g) => {
      const lim = pLimit(n); // 每个"进程"独立并发闸门
      return Promise.allSettled(g.map(([userId, client]) => lim(() => pollAccount(poller, userId, client))));
    })
  );
}

async function bench(name, fn, rounds) {
  const poller = makePoller();
  await fn(poller); // 热身建水位
  const times = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    await fn(poller);
    times.push(performance.now() - t0);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(
    `${name.padEnd(34)} 单轮均值: ${(avg / 1000).toFixed(2)}s   明细: [${times
      .map((t) => (t / 1000).toFixed(2))
      .join(', ')}]s`
  );
  return avg;
}

(async () => {
  const el = monitorEventLoopDelay({ resolution: 20 });
  el.enable();
  console.log(`===== 100 账号 x 20 群（非全连接拓扑） =====`);
  console.log(
    `拓扑: 每轮拉取 ${totalFetch} 次 (均 ${avgPerAcc.toFixed(1)}/号), 群重叠: 最热群 ${maxListeners} 号蹲守 / 平均 ${avgListeners} 号/群\n`
  );

  const tSerial = await bench('A. 原版串行 (现网实现)', runSerial, 1);
  const tP4 = await bench('B. 并行 pLimit(4) [Phase1]', (p) => runParallel(p, 4), 2);
  const tP8 = await bench('C. 并行 pLimit(8)', (p) => runParallel(p, 8), 2);
  const tP16 = await bench('D. 并行 pLimit(16)', (p) => runParallel(p, 16), 2);
  const tInf = await bench('E. 全并行 (无限制)', (p) => runParallel(p, 9999), 3);
  const tShard = await bench('F. Phase2分片模拟 4x25号 pLimit8', (p) => runSharded(p, 4, 8), 2);

  // ── 同群开奖扇出：按最热群的真实蹲守账号数 ──
  const hotAcc = maxListeners;
  const work = () => new Promise((r) => setTimeout(r, 20)); // mock 单次 handleOpen ≈ 20ms
  let t0 = performance.now();
  for (let i = 0; i < hotAcc; i++) await work();
  const fanSerial = performance.now() - t0;
  t0 = performance.now();
  await Promise.allSettled(Array.from({ length: hotAcc }, () => work()));
  const fanPar = performance.now() - t0;
  console.log(
    `\n----- 同群开奖扇出 (最热群 ${hotAcc} 账号, 单次 handleOpen≈20ms) -----`
  );
  console.log(
    `串行 for+await: ${fanSerial.toFixed(0)}ms    Promise.allSettled: ${fanPar.toFixed(0)}ms    加速 ${(fanSerial / fanPar).toFixed(1)}x`
  );

  el.disable();
  const pct = (x) => (el.percentile(x) / 1e6).toFixed(1);
  console.log('\n----- 事件循环健康度 (压测全程) -----');
  console.log(`loop lag p50=${pct(50)}ms  p99=${pct(99)}ms  max=${(el.max / 1e6).toFixed(1)}ms`);

  const judge = (t) => (t > 5000 ? '超间隔,跳轮 ✗' : '间隔内 ✓');
  console.log('\n===== 结论 =====');
  console.log(
    `轮询: 串行 ${(tSerial / 1000).toFixed(1)}s (${(tSerial / tP4).toFixed(1)}x) -> p4 ${(tP4 / 1000).toFixed(1)}s -> p8 ${(tP8 / 1000).toFixed(1)}s -> p16 ${(tP16 / 1000).toFixed(1)}s -> 全并行 ${(tInf / 1000).toFixed(1)}s (${(tSerial / tInf).toFixed(1)}x) -> 分片4x8 ${(tShard / 1000).toFixed(1)}s`
  );
  console.log(
    `5s 间隔判定: 串行 ${judge(tSerial)} | p4 ${judge(tP4)} | p8 ${judge(tP8)} | p16 ${judge(tP16)} | 全并行 ${judge(tInf)} | 分片 ${judge(tShard)}`
  );
  console.log(
    `消息量: 每轮 ${totalFetch} 次拉取 (20号版为 100 次, x${(totalFetch / 100).toFixed(1)}); dispatch 累计 ${dispatched} 条(含热身); getMessages 总调用 ${getMessagesCalls}`
  );
})().catch((e) => {
  console.error('BENCH_FAIL', e);
  process.exit(1);
});
