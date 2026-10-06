// src/bot/handlers/report.handler.js
const actionLogDao = require('../../db/action-log.dao');
const accountDao = require('../../db/account.dao');
const operationLogDao = require('../../db/operation-log.dao');
const logger = require('../../utils/logger');

/**
 * 下注记录面板
 *
 * 支持回调：
 *   report:main              → 第 0 页
 *   report:page:{n}          → 翻页
 *   report:clear_today       → 清空今日记录确认
 *   report:clear_today_do    → 执行清空今日记录（今日盈利随之归零）
 *   report:noop
 */
const PAGE_SIZE = 10;

class ReportHandler {
  static async handle(ctx, action, params, { panelRenderer, services }) {
    const botUserId = String(ctx.from.id);

    switch (action) {
      case 'main':
        await this.render(ctx, botUserId, 0, { panelRenderer });
        break;

      case 'page':
        await this.render(ctx, botUserId, parseInt(params[0], 10) || 0, { panelRenderer });
        break;

      case 'clear_today':
        await this.renderClearConfirm(ctx, botUserId, { panelRenderer, services });
        break;

      case 'clear_today_do':
        await this.handleClearToday(ctx, botUserId, { panelRenderer, services });
        break;

      case 'noop':
        break;

      default:
        logger.warn(`[REPORT] 未知操作: ${action}`);
    }
  }

  /**
   * 下注记录面板数据（列表 / 清空后复用）
   */
  static collectData(botUserId, page, services) {
    page = Math.max(0, page);
    const midnight = this._beijingMidnight();
    const todayProfit = round2(actionLogDao.sumProfit(botUserId, midnight));

    // 本轮盈利（止盈判定用）：今日总盈利 − 基准
    let roundProfit = null;
    let takeProfit = null;
    if (services && services.strategyExecutor) {
      const account = accountDao.getActive(botUserId);
      if (account && account.take_profit != null) {
        takeProfit = account.take_profit;
        roundProfit = services.strategyExecutor.getRoundProfit(account);
      }
    }

    return {
      todayProfit,
      bets: actionLogDao.listByUser(botUserId, {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
      page,
      total: actionLogDao.countByUser(botUserId),
      todayCount: actionLogDao.countSince(botUserId, midnight),
      roundProfit,
      takeProfit,
    };
  }

  static async render(ctx, botUserId, page, { panelRenderer, services }) {
    await panelRenderer.render(ctx, 'report', this.collectData(botUserId, page, services));
  }

  /**
   * 清空今日确认框
   */
  static async renderClearConfirm(ctx, botUserId, { panelRenderer, services }) {
    const midnight = this._beijingMidnight();
    const count = actionLogDao.countSince(botUserId, midnight);

    if (count === 0) {
      await panelRenderer.render(ctx, 'report', this.collectData(botUserId, 0, services));
      return;
    }

    await panelRenderer.render(ctx, 'confirm', {
      title: '清空今日下注记录',
      message:
        `将删除今日全部 <b>${count}</b> 条下注记录（北京时间 00:00 起）。\n` +
        '今日盈利统计随之归零，各群连败计数保留。\n' +
        '⚠️ 删除后不可恢复，且当前挂起 / 待发标记会一并清空。',
      confirmCallback: 'report:clear_today_do',
      cancelCallback: 'report:main',
    });
  }

  /**
   * 执行清空今日记录
   */
  static async handleClearToday(ctx, botUserId, { panelRenderer, services }) {
    const midnight = this._beijingMidnight();
    const removed = actionLogDao.deleteSince(botUserId, midnight);
    // 记录已删，挂起 / 待发标记必须一起清，否则执行器会反复自愈告警
    const cleared = actionLogDao.clearLiveFlagsByUser(botUserId);

    operationLogDao.insert({
      bot_user_id: botUserId,
      action: 'CLEAR_TODAY_BETS',
      detail: `清空今日下注记录 ${removed} 条（同时清理 ${cleared} 个群的待发/挂起标记）`,
    });
    logger.info(`[REPORT] 用户 ${botUserId} 清空今日记录 ${removed} 条`);

    await panelRenderer.render(ctx, 'report', this.collectData(botUserId, 0, services));
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
