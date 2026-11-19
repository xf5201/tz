// src/bot/handlers/login.handler.js
const logger = require('../../utils/logger');

/**
 * 登录流程回调处理
 *
 * 支持回调：
 *   login:start    → 进入手机号输入
 *   login:rephone  → 返回重输手机号
 *   login:recode   → 返回重输验证码
 *   login:cancel   → 取消登录
 *
 * 手机号 / 验证码 / 2FA 的文本输入由 login-text.handler 处理。
 */
class LoginHandler {
  static async handle(ctx, action, params, { panelRenderer }) {
    const botUserId = String(ctx.from.id);

    switch (action) {
      case 'start':
        await this.handleStart(ctx, botUserId, { panelRenderer });
        break;

      case 'rephone':
        await this.enterStep(ctx, botUserId, 'phone', { panelRenderer });
        break;

      case 'recode':
        await this.enterStep(ctx, botUserId, 'code', { panelRenderer });
        break;

      case 'cancel':
        await this.handleCancel(ctx, botUserId, { panelRenderer });
        break;

      default:
        logger.warn(`[LOGIN] 未知操作: ${action}`);
    }
  }

  static async handleStart(ctx, botUserId, { panelRenderer }) {
    await this.enterStep(ctx, botUserId, 'phone', { panelRenderer });
  }

  static async enterStep(ctx, botUserId, step, { panelRenderer }) {
    // 读取当前 wizard_state 以保留 phone 上下文
    let state = { scene: 'login', step };
    const panelCtx = ctx.panelContext;
    if (panelCtx && panelCtx.wizard_state) {
      try {
        const prev = JSON.parse(panelCtx.wizard_state);
        if (prev.scene === 'login') state = { ...prev, step };
      } catch (_) { /* 忽略 */ }
    }

    ctx.services.panelContextDao.updateWizardState(botUserId, JSON.stringify(state));
    await panelRenderer.render(ctx, 'login_panel', { step, phone: state.phone });
    logger.info(`[LOGIN] 用户 ${botUserId} 进入登录步骤: ${step}`);
  }

  static async handleCancel(ctx, botUserId, { panelRenderer }) {
    ctx.services.panelContextDao.clearWizardState(botUserId);
    await panelRenderer.render(ctx, 'dashboard', {
      user: { id: botUserId },
    });
    logger.info(`[LOGIN] 用户 ${botUserId} 取消登录`);
  }
}

module.exports = LoginHandler;
