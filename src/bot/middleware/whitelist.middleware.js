// src/bot/middleware/whitelist.middleware.js
const botUserDao = require('../../db/bot-user.dao');
const logger = require('../../utils/logger');

/**
 * 白名单校验中间件
 *
 * 职责：
 *   - 校验 bot_users.is_allowed = 1
 *   - 校验 bot_users.role IN ('USER','ADMIN')
 *   - 未通过则拒绝响应
 *
 * 使用方式（src/index.js）：
 *   bot.use(whitelistMiddleware);
 */
async function whitelistMiddleware(ctx, next) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const botUserId = String(userId);

  try {
    const user = botUserDao.getById(botUserId);

    // 用户不存在 → 首次使用，允许通过（/start 与回调路由会创建记录）
    if (!user) {
      return next();
    }

    // 白名单校验
    if (user.is_allowed !== 1) {
      logger.warn(`[WHITELIST] 用户 ${botUserId} 不在白名单中，拒绝访问`);
      await ctx.answerCbQuery?.('⛔ 您没有使用权限');
      return;
    }

    // 角色校验
    if (!['USER', 'ADMIN'].includes(user.role)) {
      logger.warn(`[WHITELIST] 用户 ${botUserId} 角色异常: ${user.role}`);
      await ctx.answerCbQuery?.('⛔ 角色异常');
      return;
    }

    return next();
  } catch (error) {
    logger.error(`[WHITELIST] 校验失败: ${error.message}`, error);
    return next(); // 校验异常时放行，避免阻塞
  }
}

module.exports = whitelistMiddleware;
