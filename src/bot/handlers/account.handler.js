// src/bot/handlers/account.handler.js
const accountDao = require('../../db/account.dao');
const monitoredChatDao = require('../../db/monitored-chat.dao');
const ruleDao = require('../../db/rule.dao');
const logger = require('../../utils/logger');

/**
 * 账号回调处理
 *
 * 支持回调：
 *   account:panel
 *   account:login
 *   account:listen_toggle
 *   account:logout_confirm / account:logout_do
 *   account:delete_confirm / account:delete_do
 */
class AccountHandler {
  static async handle(ctx, action, params, { panelRenderer, services }) {
    const botUserId = String(ctx.from.id);

    switch (action) {
      case 'panel':
        await this.handlePanel(ctx, botUserId, { panelRenderer });
        break;

      case 'login':
        // 登录入口复用 login 模块
        await require('./login.handler').handle(ctx, 'start', params, { panelRenderer, services });
        break;

      case 'listen_toggle':
        await this.handleListenToggle(ctx, botUserId, { panelRenderer, services });
        break;

      case 'logout_confirm':
        await panelRenderer.render(ctx, 'confirm', {
          title: '退出登录',
          message: '将断开连接并停止监听。\n\nSession 与历史数据全部保留，可再次登录免验证恢复。',
          confirmCallback: 'account:logout_do',
          cancelCallback: 'account:panel',
        });
        break;

      case 'logout_do':
        await services.account.logout(botUserId);
        await panelRenderer.render(ctx, 'dashboard', {
          user: { id: botUserId },
          account: null,
        });
        break;

      case 'delete_confirm':
        await panelRenderer.render(ctx, 'confirm', {
          title: '删除账号',
          message: '将删除执行账号，并清除全部监听配置、规则、开奖流水与动作记录。\n\n⛔ 此操作不可恢复！',
          confirmCallback: 'account:delete_do',
          cancelCallback: 'account:panel',
        });
        break;

      case 'delete_do':
        await services.account.deleteAccount(botUserId);
        services.listener.stopByUser(botUserId);
        await panelRenderer.render(ctx, 'dashboard', {
          user: { id: botUserId },
          account: null,
        }, { forceNew: true });
        break;

      default:
        logger.warn(`[ACCOUNT] 未知操作: ${action}`);
    }
  }

  static async handlePanel(ctx, botUserId, { panelRenderer }) {
    const account = accountDao.getActive(botUserId);
    await panelRenderer.render(ctx, 'account_panel', {
      account,
      chatCount: monitoredChatDao.countByUser(botUserId),
      ruleCount: ruleDao.countByUser(botUserId),
    });
  }

  static async handleListenToggle(ctx, botUserId, { panelRenderer, services }) {
    const account = accountDao.getActive(botUserId);
    if (!account) throw new Error('请先登录账号');

    await services.account.setListenEnabled(botUserId, !account.listen_enabled);
    logger.info(`[ACCOUNT] 用户 ${botUserId} 监听开关 → ${!account.listen_enabled ? '开' : '关'}`);

    const chats = monitoredChatDao.listByUser(botUserId);
    const rules = ruleDao.listByUser(botUserId);
    await panelRenderer.render(ctx, 'dashboard', {
      user: { id: botUserId },
      account: accountDao.getActive(botUserId),
      chats,
      rules,
    });
  }
}

module.exports = AccountHandler;
