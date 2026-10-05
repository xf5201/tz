// src/services/notification.service.js
const accountDao = require('../db/account.dao');
const monitoredChatDao = require('../db/monitored-chat.dao');
const ruleDao = require('../db/rule.dao');
const messageLogDao = require('../db/message-log.dao');
const actionLogDao = require('../db/action-log.dao');
const logger = require('../utils/logger');

/**
 * 用户通知服务
 *
 * 职责：
 *   - 推送主面板更新（规则启停、下注、账号状态变化后）
 *   - 发送事件通知（规则自动停用、动作失败等异常）
 *
 * 接口：
 *   pushToUser(botUserId)
 *   notifyEvent(botUserId, text)
 */
class NotificationService {
  /**
   * @param {object} deps
   * @param {import('telegraf').Telegraf} deps.bot - Telegraf 实例
   * @param {object} deps.panelRenderer - PanelRenderer 实例
   */
  constructor(deps) {
    this.bot = deps.bot;
    this.panelRenderer = deps.panelRenderer;
  }

  /**
   * 推送主面板更新
   *
   * 仅当用户当前正在查看 dashboard 面板时才更新
   *
   * @param {string} botUserId
   */
  async pushToUser(botUserId) {
    try {
      const account = accountDao.getActive(botUserId);
      const chats = monitoredChatDao.listByUser(botUserId);
      const rules = ruleDao.listByUser(botUserId);
      const throughput = messageLogDao.countRecent(botUserId, 10);

      // 今日盈利（今日已结算注的盈亏合计）
      const shifted = new Date(Date.now() + 8 * 3600 * 1000);
      const pad = (n) => String(n).padStart(2, '0');
      const midnight = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} 00:00:00`;
      const todayProfit = Math.round(actionLogDao.sumProfit(botUserId, midnight) * 100) / 100;

      await this.panelRenderer.pushUpdate(botUserId, 'dashboard', {
        user: { id: botUserId },
        account,
        chats,
        rules,
        throughput,
        todayProfit,
      });
    } catch (error) {
      logger.warn(`[NOTIFICATION] 推送面板失败: 用户=${botUserId}, ${error.message}`);
    }
  }

  /**
   * 发送事件通知（独立消息，不占用面板）
   *
   * @param {string} botUserId
   * @param {string} text
   */
  async notifyEvent(botUserId, text) {
    try {
      await this.bot.telegram.sendMessage(botUserId, text);
      logger.info(`[NOTIFICATION] 事件通知已发送: 用户=${botUserId}`);
    } catch (error) {
      logger.warn(`[NOTIFICATION] 事件通知发送失败: 用户=${botUserId}, ${error.message}`);
    }
  }
}

module.exports = NotificationService;
