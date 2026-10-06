// src/services/notification.service.js
const logger = require('../utils/logger');
// 复用主面板的数据组装（余额 / 停注群 / 今日盈利），保证刷新与推送显示一致
const DashboardHandler = require('../bot/handlers/dashboard.handler');

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
   * 数据与主面板「刷新」按钮完全一致（含余额、停注群、今日盈利）
   *
   * @param {string} botUserId
   */
  async pushToUser(botUserId) {
    try {
      await this.panelRenderer.pushUpdate(
        botUserId,
        'dashboard',
        DashboardHandler.collectData(botUserId)
      );
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
