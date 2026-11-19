// src/services/notification.service.js
const logger = require('../utils/logger');
const tgLimiter = require('../utils/tg-rate-limiter');
// 复用主面板的数据组装（余额 / 停注群 / 今日盈利），保证刷新与推送显示一致
const DashboardHandler = require('../bot/handlers/dashboard.handler');
const ReportHandler = require('../bot/handlers/report.handler');

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
    this.panelContextDao = deps.panelContextDao || null;
    this.services = deps.services || null;
    // 节流：同一用户最短推送间隔（避免 Telegram 429 导致更新丢失）
    this._lastPushAt = new Map();
    this.MIN_INTERVAL_MS = 1200;
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
    // 节流：短时间内重复推送会被 Telegram 限流（429），反而丢更新
    const now = Date.now();
    const last = this._lastPushAt.get(String(botUserId)) || 0;
    if (now - last < this.MIN_INTERVAL_MS) {
      this._pendingPush = this._pendingPush || new Set();
      this._pendingPush.add(String(botUserId));
      // 补一次延迟推送，保证最后一次状态变化一定能落地
      if (!this._flushTimer) {
        this._flushTimer = setTimeout(() => {
          this._flushTimer = null;
          const ids = Array.from(this._pendingPush || []);
          this._pendingPush = new Set();
          for (const id of ids) this.pushToUser(id).catch(() => {});
        }, this.MIN_INTERVAL_MS + 200);
        if (this._flushTimer.unref) this._flushTimer.unref();
      }
      return;
    }
    this._lastPushAt.set(String(botUserId), now);

    try {
      // 推送用户「当前正在看」的面板，而不是固定的 dashboard
      const panel = this.panelContextDao
        ? (this.panelContextDao.get(botUserId)?.current_panel || 'dashboard')
        : 'dashboard';
      const data = this._collectFor(panel, botUserId);
      if (data == null) return;
      await this.panelRenderer.pushUpdate(botUserId, panel, data);
    } catch (error) {
      logger.warn(`[NOTIFICATION] 推送面板失败: 用户=${botUserId}, ${error.message}`);
    }
  }

  /**
   * 按面板名组装对应的数据（无对应处理器则回退主面板）
   */
  _collectFor(panel, botUserId) {
    try {
      // 只推送「能正确组装数据」的面板，其余跳过（避免数据与面板错配）
      switch (panel) {
        case 'report':
          return ReportHandler.collectData(botUserId, 0, this.services);
        case 'dashboard':
          return DashboardHandler.collectData(botUserId);
        default:
          return null;   // 规则/群列表面板数据在别处，不动它
      }
    } catch (error) {
      logger.warn(`[NOTIFICATION] 组装面板数据失败 (${panel}): ${error.message}`);
      return null;
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
      botUserId = String(botUserId);
      // 加入发送队列：与面板推送共用同一聊天（bot 私聊），强制 1条/秒以上间隔，避免 429
      await tgLimiter.run(botUserId, () => this.bot.telegram.sendMessage(botUserId, text), {
        label: `notify.event user=${botUserId}`,
      });
      logger.info(`[NOTIFICATION] 事件通知已发送: 用户=${botUserId}`);
    } catch (error) {
      logger.warn(`[NOTIFICATION] 事件通知发送失败: 用户=${botUserId}, ${error.message}`);
    }
  }
}

module.exports = NotificationService;
