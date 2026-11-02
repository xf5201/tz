// src/services/lottery-pool.service.js
const accountDao = require('../db/account.dao');
const monitoredChatDao = require('../db/monitored-chat.dao');
const logger = require('../utils/logger');
const { maskChatId } = require('../utils/mask.util');

/**
 * 开奖池服务（广播模式轮询，替代逐账号轮询的 DicePollerService）
 *
 * 核心思想（100 号压测实测驱动，见 bench/poll-bench-100.js）：
 *   旧版逐账号轮询：每轮拉取次数 = Σ(账号 × 其监听群)，100 号非全连接拓扑下
 *   达 413 次/轮，其中最热群被 62 个账号重复拉取 62 次一模一样的数据。
 *
 *   开奖池广播模式：
 *     1. 拓扑目录：周期性重建「群 → 在线监听账号」映射，每群选出 1 个
 *        「代表账号」(rep) 负责拉取（粘性复用，失败 3 次自动换人）
 *     2. 每轮拉取次数 = 群数（100号×20群场景 413 → 20 次，-95%）
 *     3. 拉到消息后按「群级水位」增量过滤，逐条广播给 messageDispatcher：
 *        dispatcher 内部 listActiveUsersByChat(chatId) 群级扇出给全部在线
 *        监听账号 + message_logs UNIQUE(chat_id, msg_id) 全局去重兜底
 *     4. 账号侧从此零拉取、零拓扑查询；监听（NewMessage）路径完全不变，
 *        与广播双通道重复投递由 DB 去重裁决
 *
 * 与旧版的不变量（护城河，不可破坏）：
 *   - 单群内消息按 旧 → 新 顺序串行广播（开奖/结算时序不能乱）
 *   - 跨群并行（pLimit 限流），不同群之间互不阻塞
 *   - 去重始终在 DB 层（UNIQUE(chat_id, msg_id)），内存水位只是省 dispatch 量
 *   - 水位按 chatId 键控（旧版 userId:chatId）：天然支持按群分片，
 *     shardCount > 1 时可开多个池按群哈希分片（单进程多池或未来多进程均可）
 */
// 单次消息拉取超时（毫秒）：GramJS 连接假死时 getMessages 会永久挂起
const GET_MESSAGES_TIMEOUT_MS = 15000;

// 每群单次拉取的消息条数（与旧版一致）
const POLL_MESSAGE_LIMIT = 30;

// 代表账号连续拉取失败多少次后触发目录刷新换代表
const REP_FAIL_LIMIT = 3;

class LotteryPoolService {
  /**
   * @param {object} deps
   * @param {object} deps.sessionManager
   * @param {object} deps.messageDispatcher - 消息分发服务（广播出口：分类+去重+按群扇出）
   * @param {number} deps.intervalMs - 轮询间隔
   * @param {number} [deps.concurrency=8] - 跨群拉取并发上限（不同群并行，同群内串行广播）
   * @param {number} [deps.catalogRefreshMs=30000] - 拓扑目录刷新周期
   * @param {number} [deps.shardCount=1] - 池分片总数（按群哈希分片，1=单池全量）
   * @param {number} [deps.shardIndex=0] - 本池分片序号
   */
  constructor(deps) {
    this.sessionManager = deps.sessionManager;
    this.messageDispatcher = deps.messageDispatcher;
    this.intervalMs = deps.intervalMs || 5000;
    this.concurrency = Math.max(1, Number(deps.concurrency) || 8);
    this.catalogRefreshMs = Math.max(this.intervalMs, Number(deps.catalogRefreshMs) || 30000);
    this.shardCount = Math.max(1, Number(deps.shardCount) || 1);
    this.shardIndex = Math.max(0, Number(deps.shardIndex) || 0);

    this._timer = null;
    this._catalogTimer = null;
    this._polling = false;
    this._round = 0;
    this._lastRoundMs = 0;

    /** chatId -> { rep: userId, listeners: userId[] } 群拓扑目录（含代表账号） */
    this._catalog = new Map();
    /** chatId -> 已广播的最大消息 ID（群级水位；旧版为 userId:chatId） */
    this._watermarks = new Map();
    /** userId -> 连续拉取失败次数（选代表时规避不健康账号） */
    this._repFails = new Map();
    /** 跨群拉取限流器（可跨轮复用） */
    this._limit = this._makeLimit(this.concurrency);
  }

  start() {
    if (this._timer) return;
    this._catalogTimer = setInterval(() => {
      try { this._refreshCatalog(); } catch (err) {
        logger.warn(`[LOTTERY_POOL] 拓扑刷新异常: ${err.message}`);
      }
    }, this.catalogRefreshMs);
    if (this._catalogTimer.unref) this._catalogTimer.unref();

    this._timer = setInterval(() => {
      void this.pollOnce();
    }, this.intervalMs);
    if (this._timer.unref) this._timer.unref();
    logger.info(
      `[LOTTERY_POOL] 开奖池已启动: 间隔 ${this.intervalMs}ms, 拉取并发 ${this.concurrency}, ` +
      `拓扑刷新 ${this.catalogRefreshMs}ms, 分片 ${this.shardIndex + 1}/${this.shardCount}`
    );
  }

  stop() {
    if (this._catalogTimer) { clearInterval(this._catalogTimer); this._catalogTimer = null; }
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    logger.info('[LOTTERY_POOL] 开奖池已停止');
  }

  /**
   * 轮询一轮：对目录中的每个群，由代表账号拉取一次并广播
   */
  async pollOnce() {
    if (this._polling) return; // 防重叠：上一轮未结束时跳过（与旧版同款闸门）
    this._polling = true;
    this._round++;
    const t0 = Date.now();
    try {
      if (this._catalog.size === 0) this._refreshCatalog(); // 启动后首轮/全下线时立即建目录
      await Promise.allSettled(
        [...this._catalog.entries()].map(([chatId, info]) =>
          this._limit(() => this._pollChat(chatId, info))
        )
      );
    } catch (err) {
      logger.error(`[LOTTERY_POOL] 轮询异常: ${err.message}`);
    } finally {
      this._lastRoundMs = Date.now() - t0;
      this._polling = false;
      if (this._round % 60 === 0) {
        logger.info(
          `[LOTTERY_POOL] 心跳: 已轮询 ${this._round} 轮, 广播群数 ${this._catalog.size}, ` +
          `上轮耗时 ${this._lastRoundMs}ms`
        );
      }
    }
  }

  /**
   * 重建拓扑目录：群 → 在线监听账号 → 选代表拉取账号
   * 只查 DAO（SQLite 亚毫秒级），每 catalogRefreshMs 执行一次
   */
  _refreshCatalog() {
    const byChat = new Map(); // chatId -> userId[]
    for (const [userId] of this.sessionManager.getAllClients()) {
      const account = accountDao.getActive(userId);
      if (!account || account.status !== 'ACTIVE' || !account.listen_enabled) continue;
      for (const chat of monitoredChatDao.listByUser(userId)) {
        if (!byChat.has(chat.chat_id)) byChat.set(chat.chat_id, []);
        byChat.get(chat.chat_id).push(String(userId));
      }
    }

    const next = new Map();
    for (const [chatId, listeners] of byChat) {
      // 多池分片：按群哈希决定归属，池与池之间群不重叠
      if (this.shardCount > 1 && this._shardOf(chatId) !== this.shardIndex) continue;
      const rep = this._pickRep(chatId, listeners);
      if (rep) next.set(chatId, { rep, listeners });
    }
    this._catalog = next;
    // 清理已下线群的水位，防 Map 无限膨胀
    for (const chatId of this._watermarks.keys()) {
      if (!next.has(chatId)) this._watermarks.delete(chatId);
    }
    logger.info(
      `[LOTTERY_POOL] 拓扑刷新: 广播 ${next.size} 个群 ` +
      `(分片 ${this.shardIndex + 1}/${this.shardCount}), 每轮拉取 ${next.size} 次`
    );
  }

  /**
   * 选代表账号：上次代表仍健康则粘性复用（避免频繁换连接），
   * 否则按连续失败次数升序取最健康的监听账号
   */
  _pickRep(chatId, listeners) {
    const failOf = (u) => this._repFails.get(u) || 0;
    const prev = this._catalog.get(chatId);
    if (prev && listeners.includes(prev.rep) && failOf(prev.rep) < REP_FAIL_LIMIT) {
      return prev.rep;
    }
    const sorted = [...listeners].sort((a, b) => failOf(a) - failOf(b));
    return sorted[0] || null;
  }

  /**
   * 广播单群：代表账号拉取一次 → 群级水位增量过滤 → 逐条广播给分发器
   * 单群内严格 旧 → 新 串行（开奖/结算时序不变量）
   */
  async _pollChat(chatId, info) {
    const client = this.sessionManager.getClient(info.rep);
    if (!client) {
      // 代表已掉线：立即刷新目录换代表，不等失败计数
      this._repFails.set(info.rep, REP_FAIL_LIMIT);
      logger.warn(`[LOTTERY_POOL] 群 ${maskChatId(chatId)} 代表账号 ${info.rep} 已掉线，刷新拓扑`);
      this._refreshCatalog();
      return;
    }

    let msgs;
    try {
      msgs = await this._getMessagesWithTimeout(client, chatId, POLL_MESSAGE_LIMIT);
      this._repFails.delete(info.rep); // 成功即重置失败计数
    } catch (err) {
      const fails = (this._repFails.get(info.rep) || 0) + 1;
      this._repFails.set(info.rep, fails);
      logger.warn(
        `[LOTTERY_POOL] 群 ${maskChatId(chatId)} 拉取失败(代表=${info.rep}, ` +
        `连续第${fails}次): ${err.message}`
      );
      if (fails >= REP_FAIL_LIMIT) {
        logger.warn(`[LOTTERY_POOL] 代表 ${info.rep} 连续失败 ${fails} 次，刷新拓扑换代表`);
        this._refreshCatalog(); // 下轮起由更健康的账号接管该群
      }
      return;
    }

    const watermark = this._watermarks.get(chatId) || 0;
    // 首轮：只建立群级水位（取最新一条消息 ID），不补发历史（避免虚假连击）
    if (watermark === 0) {
      if (msgs.length) this._watermarks.set(chatId, Number(msgs[0].id));
      return;
    }

    // GramJS 语义：新 → 旧，反转为 旧 → 新 逐条广播；
    // dispatch 内部做群级扇出 + DB 去重（与监听/多池重复投递安全共存）
    for (const m of msgs.slice().reverse()) {
      const msgIdNum = Number(m.id);
      if (msgIdNum <= (this._watermarks.get(chatId) || 0)) continue;
      this._watermarks.set(chatId, msgIdNum);
      try {
        await this.messageDispatcher.dispatch(m, chatId);
      } catch (err) {
        logger.error(
          `[LOTTERY_POOL] 广播异常: 群=${maskChatId(chatId)}, 消息=${m.id}, ${err.message}`
        );
      }
    }
  }

  /**
   * 带超时保护的消息拉取；超时说明连接假死，主动重连后再抛错（与旧版同款兜底）
   */
  async _getMessagesWithTimeout(client, chatId, limit, timeoutMs = GET_MESSAGES_TIMEOUT_MS) {
    return Promise.race([
      client.getMessages(chatId, { limit }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`getMessages 超时（${timeoutMs / 1000}s，连接假死）`)), timeoutMs)
      ),
    ]).catch(async (err) => {
      if (String(err.message).includes('getMessages 超时')) {
        logger.warn(`[LOTTERY_POOL] 群 ${maskChatId(chatId)} 拉取超时，尝试刷新连接`);
        try { await client.connect(); } catch (_) { /* 由下轮重试 */ }
      }
      throw err;
    });
  }

  /** 群 ID 哈希 → 分片序号 */
  _shardOf(chatId) {
    let h = 0;
    const s = String(chatId);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h) % this.shardCount;
  }

  /** 零依赖 pLimit（队列 + active 计数） */
  _makeLimit(n) {
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
}

module.exports = LotteryPoolService;
