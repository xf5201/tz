// src/bot/handlers/dashboard.handler.js
const accountDao = require('../../db/account.dao');
const monitoredChatDao = require('../../db/monitored-chat.dao');
const ruleDao = require('../../db/rule.dao');
const ruleStateDao = require('../../db/rule-state.dao');
const messageLogDao = require('../../db/message-log.dao');
const actionLogDao = require('../../db/action-log.dao');
const operationLogDao = require('../../db/operation-log.dao');
const logger = require('../../utils/logger');

/**
 * 主面板回调处理
 *
 * 支持回调：
 *   dashboard:refresh          → 刷新主面板
 *   dashboard:resume_chats     → 人工恢复全部停注群
 */
class DashboardHandler {
  static async handle(ctx, action, params, { panelRenderer, services }) {
    const botUserId = String(ctx.from.id);

    switch (action) {
      case 'refresh':
        await this.handleRefresh(ctx, botUserId, { panelRenderer });
        break;

      case 'resume_chats':
        await this.handleResumeChats(ctx, botUserId, { panelRenderer, services });
        break;

      default:
        logger.warn(`[DASHBOARD] 未知操作: ${action}`);
    }
  }

  /**
   * 今日零点（北京时间，与 SQLite datetime('now','+8 hours') 对齐）
   */
  static _beijingMidnight() {
    const shifted = new Date(Date.now() + 8 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} 00:00:00`;
  }

  /**
   * 主面板数据（刷新按钮与 30 秒定时刷新共用）
   */
  static collectData(botUserId) {
    const account = accountDao.getActive(botUserId);
    const chats = monitoredChatDao.listByUser(botUserId);
    const rules = ruleDao.listByUser(botUserId);
    const throughput = messageLogDao.countRecent(botUserId, 10);
    const latestFailed = actionLogDao.latestFailed(botUserId);
    const todayProfit = Math.round(actionLogDao.sumProfit(botUserId, this._beijingMidnight()) * 100) / 100;

    // 停注群（连败 / 止损达上限被单独停掉的「规则 × 群」）
    const titleByChat = {};
    for (const c of chats) titleByChat[String(c.chat_id)] = c.chat_title;
    const blockedChats = ruleStateDao.listBlockedByUser(botUserId).map((b) => ({
      ...b,
      chat_title: titleByChat[String(b.chat_id)] || null,
    }));

    return {
      user: { id: botUserId },
      account,
      chats,
      rules,
      throughput,
      todayProfit,
      latestFailed,
      blockedChats,
    };
  }

  static async handleRefresh(ctx, botUserId, { panelRenderer }) {
    await panelRenderer.render(ctx, 'dashboard', this.collectData(botUserId));
  }

  /**
   * 人工一键恢复全部停注群（连败清零）
   */
  static async handleResumeChats(ctx, botUserId, { panelRenderer, services }) {
    const n = services.strategyExecutor.resumeBlockedChats(botUserId);
    if (n > 0) {
      operationLogDao.insert({
        bot_user_id: botUserId,
        action: 'CHAT_MANUAL_RESUMED',
        detail: `主面板人工恢复 ${n} 个停注群`,
      });
    }
    await panelRenderer.render(ctx, 'dashboard', this.collectData(botUserId));
  }
}

module.exports = DashboardHandler;
