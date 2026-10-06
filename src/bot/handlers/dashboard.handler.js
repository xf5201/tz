// src/bot/handlers/dashboard.handler.js
const accountDao = require('../../db/account.dao');
const monitoredChatDao = require('../../db/monitored-chat.dao');
const ruleDao = require('../../db/rule.dao');
const ruleStateDao = require('../../db/rule-state.dao');
const messageLogDao = require('../../db/message-log.dao');
const actionLogDao = require('../../db/action-log.dao');
const operationLogDao = require('../../db/operation-log.dao');
const logger = require('../../utils/logger');
const { calcRoundProfit, isBaselineStale } = require('../../core/profit.guard');

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

      case 'alert_toggle':
        await this.handleAlertToggle(ctx, botUserId, { panelRenderer });
        break;

      case 'alert_reset':
        await this.handleAlertReset(ctx, botUserId, { panelRenderer });
        break;

      case 'take_profit':
        // 进入自定义输入：输入目标金额；输入 0 = 关闭止盈
        await ctx.scene.enter('input', { field: 'take_profit' });
        break;

      case 'resume_profit':
        await this.handleResumeProfit(ctx, botUserId, { panelRenderer, services });
        break;

      case 'query_balance':
        await this.handleQueryBalance(ctx, botUserId, { panelRenderer, services });
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

    // 本轮盈利（止盈判定用）：今日总盈利 − 基准；跨天则基准作废，从头算
    let roundProfit = null;
    if (account) {
      const baseline = isBaselineStale(account.profit_baseline_date) ? 0 : account.profit_baseline;
      roundProfit = calcRoundProfit(todayProfit, baseline);
    }

    return {
      user: { id: botUserId },
      account,
      chats,
      rules,
      throughput,
      todayProfit,
      latestFailed,
      blockedChats,
      roundProfit,
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

  /**
   * 亏损预警开关：开启后，当前余额跌破初始余额一半时主动发消息告警
   */
  static async handleAlertToggle(ctx, botUserId, { panelRenderer }) {
    const account = accountDao.getActive(botUserId);
    if (!account) {
      await panelRenderer.render(ctx, 'dashboard', this.collectData(botUserId));
      return;
    }

    const enabled = account.alert_enabled ? 0 : 1;

    // 开启预警必须有基准：初始余额只能由「🔍 初始化余额」确定，
    // 不能拿当前余额凑数（那是个随机时刻的值，当基准没意义）
    if (enabled === 1
        && (account.initial_balance == null || Number(account.initial_balance) <= 0)) {
      logger.warn(`[DASHBOARD] 用户 ${botUserId} 未初始化余额，无法开启亏损预警`);
      await panelRenderer.render(ctx, 'dashboard', this.collectData(botUserId));
      return;
    }

    accountDao.setAlertEnabled(botUserId, enabled);

    operationLogDao.insert({
      bot_user_id: botUserId,
      action: enabled ? 'ENABLE_LOSS_ALERT' : 'DISABLE_LOSS_ALERT',
      detail: enabled
        ? `开启亏损预警（基准 ${account.initial_balance ?? account.balance}，跌破一半告警）`
        : '关闭亏损预警',
    });

    await panelRenderer.render(ctx, 'dashboard', this.collectData(botUserId));
  }

  /**
   * 重置亏损基准：把当前余额设为新的初始余额
   * （充值后或想重新开始统计时使用，重置后告警重新武装）
   */
  static async handleAlertReset(ctx, botUserId, { panelRenderer }) {
    const account = accountDao.getActive(botUserId);
    if (!account || account.balance == null) {
      await panelRenderer.render(ctx, 'dashboard', this.collectData(botUserId));
      return;
    }

    accountDao.setInitialBalance(botUserId, account.balance);
    operationLogDao.insert({
      bot_user_id: botUserId,
      action: 'RESET_LOSS_BASELINE',
      detail: `重置亏损基准为当前余额 ${account.balance}`,
    });

    await panelRenderer.render(ctx, 'dashboard', this.collectData(botUserId));
  }

  /**
   * 恢复运行（达到止盈后由用户手动触发）
   *
   * 只清「本轮盈利」，今日总盈利不动 —— 它是实打实的下注记录累计出来的。
   */
  static async handleResumeProfit(ctx, botUserId, { panelRenderer, services }) {
    if (!services || !services.strategyExecutor) {
      await panelRenderer.render(ctx, 'dashboard', this.collectData(botUserId));
      return;
    }

    await services.strategyExecutor.resumeFromTakeProfit(botUserId);
    await panelRenderer.render(ctx, 'dashboard', this.collectData(botUserId));
  }

  /**
   * 主动查询余额：往一个已监听的群发「余额」，机器人回复后自动更新
   *
   * 用于充值后立刻刷新（不用重启、不用等下一次下注回复）。
   */
  static async handleQueryBalance(ctx, botUserId, { panelRenderer, services }) {
    if (services && services.balanceQuery) {
      const res = await services.balanceQuery.queryBalance(botUserId).catch(() => null);
      if (res && !res.sent) {
        logger.warn(`[DASHBOARD] 用户 ${botUserId} 余额查询未发出: ${res.reason}`);
      }
    }
    await panelRenderer.render(ctx, 'dashboard', this.collectData(botUserId));
  }
}

module.exports = DashboardHandler;
