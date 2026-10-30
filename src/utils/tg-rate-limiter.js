// src/utils/tg-rate-limiter.js
/**
 * Telegram 出站速率限制器（单例）
 *
 * 解决 429 Too Many Requests：
 *   1. 全局串行队列——出站请求一个一个发，不并发轰炸
 *   2. 每聊天最小间隔——个性化消息官方限速 1 条/秒，默认留 1100ms 余量
 *   3. 全局突发保护——滑动窗口计数，防止瞬时尖峰撞穿（默认 25 条/秒）
 *   4. 429 自动重试——解析 retry_after（Telegraf: err.response.parameters.retry_after；
 *      GramJS: FLOOD_WAIT_<n>），睡够后原样重试
 *
 * 用法：
 *   const tgLimiter = require('../utils/tg-rate-limiter');
 *   const result = await tgLimiter.run(chatKey, () => telegram.editMessageText(...));
 *   // chatKey 传「聊天身份」字符串（chat_id / bot_user_id），同聊天自动拉开间隔
 */
class TgRateLimiter {
  constructor({
    perChatIntervalMs = 1100,   // 同一聊天两次出站的最小间隔
    globalWindowMs = 1000,      // 全局滑动窗口
    globalBurstMax = 25,        // 窗口内全局最多请求数（官方批量上限 30，留余量）
    maxRetry = 3,               // 429 自动重试次数上限
    maxWaitMs = 30000,          // retry_after 超过该值放弃重试（通知类消息不值得等）
    queueWarnLen = 30,          // 队列积压超过该条数时打警告日志
  } = {}) {
    this.perChatIntervalMs = perChatIntervalMs;
    this.globalWindowMs = globalWindowMs;
    this.globalBurstMax = globalBurstMax;
    this.maxRetry = maxRetry;
    this.maxWaitMs = maxWaitMs;
    this.queueWarnLen = queueWarnLen;
    this._queue = [];            // 待执行的 { chatKey, task, resolve, reject, label }
    this._draining = false;
    this._lastAtByChat = new Map(); // chatKey → 上次发送时间戳
    this._globalHits = [];       // 滑动窗口时间戳
  }

  /**
   * 排队执行一个出站请求（自动限速 + 429 重试）
   * @param {string} chatKey 聊天身份（chat_id 或 bot_user_id）
   * @param {() => Promise<any>} task 出站调用
   * @param {object} [opts]
   * @param {string} [opts.label] 日志标签
   * @returns {Promise<any>} task 的结果；重试用尽时抛出最后一个错误
   */
  run(chatKey, task, opts = {}) {
    const key = String(chatKey ?? 'unknown');
    if (this._queue.length === this.queueWarnLen) {
      // 只在恰好到达阈值时告警一次，避免刷屏
      console.warn(`[TG_LIMITER] 队列积压已达 ${this._queue.length}，出站压力偏大 (${opts.label || ''})`);
    }
    return new Promise((resolve, reject) => {
      this._queue.push({ chatKey: key, task, resolve, reject, label: opts.label });
      this._drain();
    });
  }

  async _drain() {
    if (this._draining) return;
    this._draining = true;
    while (this._queue.length > 0) {
      const item = this._queue.shift();
      try {
        const result = await this._execute(item);
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      }
    }
    this._draining = false;
  }

  async _execute({ chatKey, task, label }) {
    let attempt = 0;
    for (;;) {
      await this._waitForSlots(chatKey, label);
      try {
        return await task();
      } catch (err) {
        const waitSeconds = this._parseRetryAfter(err);
        if (waitSeconds == null || attempt >= this.maxRetry) throw err;
        const waitMs = Math.min(waitSeconds * 1000 + 300, this.maxWaitMs);
        if (waitSeconds * 1000 + 300 > this.maxWaitMs) throw err; // 等太久，通知类直接放弃
        attempt++;
        console.warn(
          `[TG_LIMITER] 429限流, ${waitMs}ms 后重试 ${attempt}/${this.maxRetry} (${label || 'telegram'})`
        );
        await sleep(waitMs);
      }
    }
  }

  /** 保证不违反每聊天间隔与全局突发上限 */
  async _waitForSlots(chatKey, label) {
    for (;;) {
      const now = Date.now();
      // 1. 全局滑动窗口
      this._globalHits = this._globalHits.filter((t) => now - t < this.globalWindowMs);
      if (this._globalHits.length >= this.globalBurstMax) {
        const waitMs = this.globalWindowMs - (now - this._globalHits[0]) + 20;
        await sleep(waitMs);
        continue;
      }
      // 2. 每聊天最小间隔
      const last = this._lastAtByChat.get(chatKey) || 0;
      const elapsed = now - last;
      if (elapsed < this.perChatIntervalMs) {
        await sleep(this.perChatIntervalMs - elapsed);
        continue;
      }
      // 占位
      this._lastAtByChat.set(chatKey, Date.now());
      this._globalHits.push(Date.now());
      return;
    }
  }

  /** 从错误里解析需要的等待秒数；非限流错误返回 null */
  _parseRetryAfter(err) {
    if (!err) return null;
    // Telegraf/Node: err.response.parameters.retry_after
    const t = err.response && err.response.parameters && err.response.parameters.retry_after;
    if (Number.isFinite(t)) return t;
    //gramJS FLOOD_WAIT_<n>
    const m = /FLOOD_WAIT_(\d+)/.exec(err.errorMessage || '');
    if (m) return Number(m[1]);
    const d = /retry after (\d+)/i.exec(err.description || err.message || '');
    if (d) return Number(d[1]);
    const tooMany = /Too Many Requests|429/i.test(err.description || err.message || '');
    if (tooMany) return 2; // 未知时长，保守等 2 秒
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 单例：全进程共用一个队列，出站消息统一调度
module.exports = new TgRateLimiter();
module.exports.TgRateLimiter = TgRateLimiter;
