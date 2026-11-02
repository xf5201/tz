// src/bot/handlers/callback.router.js
const logger = require('../../utils/logger');
const botUserDao = require('../../db/bot-user.dao');

/**
 * 回调路由器
 *
 * 解析 callbackQuery.data → {module}:{action}[:{param}]
 * 分发到对应 handler
 */
class CallbackRouter {
  constructor(panelRenderer, services) {
    this.panelRenderer = panelRenderer;
    this.services = services;

    // 注册各模块 handler
    this.handlers = {
      dashboard: require('./dashboard.handler'),
      account: require('./account.handler'),
      login: require('./login.handler'),
      chat: require('./chat.handler'),
      rule: require('./rule.handler'),
      report: require('./report.handler'),
    };
  }

  /**
   * 安全地关闭按钮加载状态
   * 防止 query is too old / query ID is invalid 导致二次崩溃
   */
  async safeAnswerCbQuery(ctx, text, options = {}) {
    try {
      await ctx.answerCbQuery(text, options);
    } catch (err) {
      const description = err.description || err.message || '';
      if (
        description.includes('query is too old') ||
        description.includes('query ID is invalid')
      ) {
        logger.warn(`[CALLBACK] 忽略已过期的按钮请求 (${ctx.callbackQuery?.data})`);
      } else {
        logger.error(`[CALLBACK] answerCbQuery 失败: ${err.message}`);
      }
    }
  }

  /**
   * 统一入口：解析 callback data 并分发
   * @param {import('telegraf').Context} ctx
   */
  async handle(ctx) {
    const data = ctx.callbackQuery?.data;
    if (!data) {
      await this.safeAnswerCbQuery(ctx, '无效请求');
      return;
    }

    // ── 确保 bot_users 表中有该用户记录 ──
    const tgUser = ctx.from;
    const botUserId = String(tgUser.id);
    try {
      botUserDao.upsert({
        bot_user_id: botUserId,
        username: tgUser.username || null,
        first_name: tgUser.first_name || null,
      });
    } catch (err) {
      logger.error(`[CALLBACK] 创建用户记录失败: ${err.message}`);
    }

    const [module, action, ...params] = data.split(':');
    logger.debug(`[CALLBACK] 收到回调: ${data} (module=${module}, action=${action})`);

    try {
      const handler = this.handlers[module];
      if (!handler) {
        logger.warn(`[CALLBACK] 未知模块: ${module}`);
        await this.safeAnswerCbQuery(ctx, '未知操作');
        return;
      }

      // 调用对应 handler，统一传入依赖
      await handler.handle(ctx, action, params, {
        panelRenderer: this.panelRenderer,
        services: this.services,
      });

      // 静默关闭 Telegram 按钮转圈状态
      await this.safeAnswerCbQuery(ctx);
    } catch (error) {
      logger.error(`[CALLBACK] 处理失败: ${data} → ${error.message}`, error);
      await this.safeAnswerCbQuery(ctx, `操作失败：${error.message}`, { show_alert: true });
    }
  }
}

module.exports = CallbackRouter;
