// src/bot/handlers/dashboard.handler.js
const accountDao = require('../../db/account.dao');
const monitoredChatDao = require('../../db/monitored-chat.dao');
const ruleDao = require('../../db/rule.dao');
const messageLogDao = require('../../db/message-log.dao');
const actionLogDao = require('../../db/action-log.dao');
const logger = require('../../utils/logger');

/**
 * 主面板回调处理
 *
 * 支持回调：
 *   dashboard:refresh
 */
class DashboardHandler {
  static async handle(ctx, action, params, { panelRenderer }) {
    const botUserId = String(ctx.from.id);

    switch (action) {
      case 'refresh':
        await this.handleRefresh(ctx, botUserId, { panelRenderer });
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

  static async handleRefresh(ctx, botUserId, { panelRenderer }) {
    const account = accountDao.getActive(botUserId);
    const chats = monitoredChatDao.listByUser(botUserId);
    const rules = ruleDao.listByUser(botUserId);
    const throughput = messageLogDao.countRecent(botUserId, 10);
    const latestFailed = actionLogDao.latestFailed(botUserId);

    // 今日盈利（今日已结算注的盈亏合计）
    const todayProfit = Math.round(actionLogDao.sumProfit(botUserId, this._beijingMidnight()) * 100) / 100;

    await panelRenderer.render(ctx, 'dashboard', {
      user: { id: botUserId },
      account,
      chats,
      rules,
      throughput,
      todayProfit,
      latestFailed,
    });
  }
}

module.exports = DashboardHandler;
