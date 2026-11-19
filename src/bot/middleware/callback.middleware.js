// src/bot/middleware/callback.middleware.js
const logger = require('../../utils/logger');

/**
 * Callback 幂等校验中间件
 *
 * 职责：
 *   - 防止同一 callback_query 被重复处理
 *   - 使用内存 Set 记录已处理的 callback_query.id
 *   - 定期清理过期记录，防止内存泄漏
 *
 * 使用方式（src/index.js）：
 *   bot.use(callbackMiddleware);
 */

// 已处理的 callback ID 集合
const processedCallbacks = new Set();

// 最大缓存数量（防止内存泄漏）
const MAX_CACHE_SIZE = 10000;

// 定期清理（每 5 分钟）
const CLEANUP_INTERVAL = 5 * 60 * 1000;

let cleanupTimer = null;

/**
 * 启动定期清理
 */
function startCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    if (processedCallbacks.size > MAX_CACHE_SIZE) {
      const entries = Array.from(processedCallbacks);
      const removeCount = entries.length - Math.floor(MAX_CACHE_SIZE / 2);
      for (let i = 0; i < removeCount; i++) {
        processedCallbacks.delete(entries[i]);
      }
      logger.info(`[CALLBACK_MW] 清理了 ${removeCount} 条过期回调记录`);
    }
  }, CLEANUP_INTERVAL);

  // 允许进程退出
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }
}

/**
 * Callback 幂等中间件
 */
async function callbackMiddleware(ctx, next) {
  // 仅处理 callback_query
  if (!ctx.callbackQuery) {
    return next();
  }

  const callbackId = ctx.callbackQuery.id;
  if (!callbackId) {
    return next();
  }

  // 幂等校验：已处理过则跳过
  if (processedCallbacks.has(callbackId)) {
    logger.debug(`[CALLBACK_MW] 重复回调已忽略: ${callbackId}`);
    try {
      await ctx.answerCbQuery();
    } catch (_) {
      // 忽略
    }
    return;
  }

  // 记录已处理
  processedCallbacks.add(callbackId);

  // 启动清理定时器
  startCleanup();

  return next();
}

module.exports = callbackMiddleware;
