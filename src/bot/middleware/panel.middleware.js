// src/bot/middleware/panel.middleware.js
const panelContextDao = require('../../db/panel-context.dao');
const logger = require('../../utils/logger');

/**
 * 面板上下文注入中间件
 *
 * 职责：
 *   - 将 panel_context 注入到 ctx.panelContext
 *   - 供后续 handler / panel 使用
 *   - 如果用户没有 panel_context，则 ctx.panelContext = null
 *
 * 使用方式（src/index.js）：
 *   bot.use(panelMiddleware);
 */
async function panelMiddleware(ctx, next) {
  const userId = ctx.from?.id;
  if (!userId) {
    return next();
  }

  const botUserId = String(userId);

  try {
    const panelCtx = panelContextDao.get(botUserId);
    ctx.panelContext = panelCtx || null;
  } catch (error) {
    logger.warn(`[PANEL_MW] 读取面板上下文失败: ${error.message}`);
    ctx.panelContext = null;
  }

  return next();
}

module.exports = panelMiddleware;
