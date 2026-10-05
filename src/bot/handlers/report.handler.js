// src/bot/handlers/report.handler.js
const actionLogDao = require('../../db/action-log.dao');
const logger = require('../../utils/logger');

/**
 * 下注记录面板
 *
 * 支持回调：
 *   report:main       → 第 0 页
 *   report:page:{n}   → 翻页
 *   report:noop
 */
const PAGE_SIZE = 10;

class ReportHandler {
  static async handle(ctx, action, params, { panelRenderer }) {
    const botUserId = String(ctx.from.id);

    switch (action) {
      case 'main':
        await this.render(ctx, botUserId, 0, { panelRenderer });
        break;

      case 'page':
        await this.render(ctx, botUserId, parseInt(params[0], 10) || 0, { panelRenderer });
        break;

      case 'noop':
        break;

      default:
        logger.warn(`[REPORT] 未知操作: ${action}`);
    }
  }

  static async render(ctx, botUserId, page, { panelRenderer }) {
    page = Math.max(0, page);
    const midnight = this._beijingMidnight();

    await panelRenderer.render(ctx, 'report', {
      todayProfit: round2(actionLogDao.sumProfit(botUserId, midnight)),
      bets: actionLogDao.listByUser(botUserId, {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
      page,
      total: actionLogDao.countByUser(botUserId),
    });
  }

  /**
   * 今日零点（北京时间，与 SQLite datetime('now','+8 hours') 对齐）
   * @returns {string} 'YYYY-MM-DD HH:mm:ss'
   */
  static _beijingMidnight() {
    const shifted = new Date(Date.now() + 8 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} 00:00:00`;
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = ReportHandler;
