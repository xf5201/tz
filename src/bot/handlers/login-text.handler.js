// src/bot/handlers/login-text.handler.js
const logger = require('../../utils/logger');
const { maskPhone } = require('../../utils/mask.util');

/**
 * 登录文本处理器
 *
 * 负责处理用户在登录流程中发送的文本：
 * 1. 手机号
 * 2. 验证码
 * 3. 2FA 密码
 *
 * 核心原则：
 * - 单消息模式：处理完用户的输入后，立刻删除用户发送的消息，保持聊天界面只有面板消息。
 * - 安全脱敏：不记录验证码原文、不记录 2FA 密码原文、手机号日志必须脱敏。
 */
class LoginTextHandler {
  constructor({ panelRenderer, panelContextDao, accountService }) {
    this.panelRenderer = panelRenderer;
    this.panelContextDao = panelContextDao;
    this.accountService = accountService;
  }

  /**
   * 处理文本消息
   * @returns {boolean} 是否已处理
   */
  async handle(ctx) {
    if (!ctx.message) {
      return false;
    }

    // 如果是命令（例如 /start），不拦截，也不删除，让后续的命令处理器处理
    if (ctx.message.text && ctx.message.text.startsWith('/')) {
      return false;
    }

    const botUserId = String(ctx.from.id);
    const panelCtx = this.panelContextDao.get(botUserId);

    if (!panelCtx || !panelCtx.wizard_state) {
      return false;
    }

    let state;
    try {
      state = JSON.parse(panelCtx.wizard_state);
    } catch (error) {
      logger.warn(`[LOGIN_TEXT] 用户 ${botUserId} wizard_state 非法，已清空`);
      this.panelContextDao.clearWizardState(botUserId);
      return false;
    }

    if (!state || state.scene !== 'login') {
      return false;
    }

    // ═══════════════════════════════════════════
    // 【核心动作】：删除用户发送的消息
    // 无论是文本、验证码还是误发的表情，只要处于登录流程，统统删除，保持界面干净
    // ═══════════════════════════════════════════
    try {
      await ctx.deleteMessage();
    } catch (err) {
      logger.warn(`[LOGIN_TEXT] 删除用户消息失败: ${err.description || err.message}`);
    }

    // 如果不是纯文本消息（比如用户发了个表情或图片），删除后直接结束，不做业务处理
    if (!ctx.message.text) {
      return true;
    }

    const text = ctx.message.text.trim();
    if (!text) {
      return true;
    }

    // 根据当前步骤分发处理
    if (state.step === 'phone') {
      await this.handlePhone(ctx, botUserId, state, text);
      return true;
    }

    if (state.step === 'code') {
      await this.handleCode(ctx, botUserId, state, text);
      return true;
    }

    if (state.step === '2fa') {
      await this.handle2FA(ctx, botUserId, state, text);
      return true;
    }

    return true;
  }

  /**
   * 处理手机号
   */
  async handlePhone(ctx, botUserId, state, phone) {
    if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
      await this.panelRenderer.render(ctx, 'login_panel', {
        step: 'phone',
        errorMessage: '手机号格式错误，请以 + 开头，例如 +8613812341234',
      });
      return;
    }

    logger.info(`[LOGIN_TEXT] 用户 ${botUserId} 提交手机号: ${maskPhone(phone)}`);

    try {
      await this.accountService.initiateLogin(botUserId, phone);

      state.step = 'code';
      state.phone = phone;

      this.panelContextDao.updateWizardState(botUserId, JSON.stringify(state));

      await this.panelRenderer.render(ctx, 'login_panel', {
        step: 'code',
        phone,
      });
    } catch (error) {
      logger.error(`[LOGIN_TEXT] 用户 ${botUserId} initiateLogin 失败: ${error.message}`);

      await this.panelRenderer.render(ctx, 'login_panel', {
        step: 'phone',
        errorMessage: `登录失败：${error.message}`,
      });
    }
  }

  /**
   * 处理验证码
   */
  async handleCode(ctx, botUserId, state, userText) {
    const normalized = userText.replace(/\D/g, '');

    // 不限制位数，只要包含数字即可
    if (!/^\d+$/.test(normalized)) {
      await this.panelRenderer.render(ctx, 'login_panel', {
        step: 'code',
        phone: state.phone,
        errorMessage: '验证码格式错误，请输入数字验证码',
      });
      return;
    }

    logger.info(`[LOGIN_TEXT] 用户 ${botUserId} 提交验证码`);

    try {
      const result = await this.accountService.submitCode(botUserId, normalized);

      if (result && result.need2FA) {
        state.step = '2fa';

        this.panelContextDao.updateWizardState(botUserId, JSON.stringify(state));

        await this.panelRenderer.render(ctx, 'login_panel', {
          step: '2fa',
          phone: state.phone,
        });

        return;
      }

      this.panelContextDao.clearWizardState(botUserId);

      await this.panelRenderer.render(ctx, 'login_panel', {
        step: 'success',
        phone: state.phone,
      });
    } catch (error) {
      logger.error(`[LOGIN_TEXT] 用户 ${botUserId} submitCode 失败: ${error.message}`);

      await this.panelRenderer.render(ctx, 'login_panel', {
        step: 'code',
        phone: state.phone,
        errorMessage: `验证码错误：${error.message}`,
      });
    }
  }

  /**
   * 处理 2FA 密码
   */
  async handle2FA(ctx, botUserId, state, password) {
    logger.info(`[LOGIN_TEXT] 用户 ${botUserId} 提交 2FA`);

    try {
      await this.accountService.submit2FA(botUserId, password);

      this.panelContextDao.clearWizardState(botUserId);

      await this.panelRenderer.render(ctx, 'login_panel', {
        step: 'success',
        phone: state.phone,
      });
    } catch (error) {
      logger.error(`[LOGIN_TEXT] 用户 ${botUserId} submit2FA 失败: ${error.message}`);

      await this.panelRenderer.render(ctx, 'login_panel', {
        step: '2fa',
        phone: state.phone,
        errorMessage: `2FA 错误：${error.message}`,
      });
    }
  }
}

module.exports = LoginTextHandler;
