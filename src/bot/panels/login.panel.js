// src/bot/panels/login.panel.js
const { Markup } = require('telegraf');
const { maskPhone } = require('../../utils/mask.util');

/**
 * 登录面板（LoginPanel）
 *
 * 子面板（data.step 区分）：
 *   phone   → 输入手机号
 *   code    → 输入验证码
 *   2fa     → 输入云密码（二步验证）
 *   success → 登录成功
 */
class LoginPanel {
  static async render(ctx, data) {
    const step = data.step || 'phone';
    switch (step) {
      case 'code': return this.buildCode(data);
      case '2fa': return this.build2FA(data);
      case 'success': return this.buildSuccess(data);
      case 'phone':
      default: return this.buildPhone(data);
    }
  }

  static buildPhone({ errorMessage }) {
    let text = '📱 <b>登录执行账号 ①/③</b>\n';
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += '请直接发送手机号消息（含国际区号）\n';
    text += '示例：<code>+8613812341234</code>\n';
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    if (errorMessage) {
      text += `❌ ${errorMessage}\n`;
      text += '━━━━━━━━━━━━━━━━━━━━\n';
    }
    text += '🔒 仅支持登录与当前机器人对话相同的本人账号';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('❎ 取消登录', 'login:cancel')],
    ]);
    return { text, keyboard };
  }

  static buildCode({ phone, errorMessage }) {
    let text = '🔢 <b>登录执行账号 ②/③</b>\n';
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += `账号：${maskPhone(phone || '')}\n`;
    text += '请直接发送 Telegram 发来的验证码\n';
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    if (errorMessage) {
      text += `❌ ${errorMessage}\n`;
      text += '━━━━━━━━━━━━━━━━━━━━\n';
    }
    text += '💡 验证码消息发送后会被自动删除，请放心输入';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ 重新输入手机号', 'login:rephone')],
      [Markup.button.callback('❎ 取消登录', 'login:cancel')],
    ]);
    return { text, keyboard };
  }

  static build2FA({ phone, errorMessage }) {
    let text = '🔐 <b>登录执行账号 ③/③</b>\n';
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += `账号：${maskPhone(phone || '')}\n`;
    text += '该账号已开启二步验证（云密码）\n';
    text += '请直接发送云密码\n';
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    if (errorMessage) {
      text += `❌ ${errorMessage}\n`;
      text += '━━━━━━━━━━━━━━━━━━━━\n';
    }
    text += '💡 密码消息发送后会被自动删除，请放心输入';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ 重新输入验证码', 'login:recode')],
      [Markup.button.callback('❎ 取消登录', 'login:cancel')],
    ]);
    return { text, keyboard };
  }

  static buildSuccess({ phone }) {
    let text = '✅ <b>登录成功</b>\n';
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += `账号：${maskPhone(phone || '')}\n`;
    text += 'Session 已保存，下次启动免登录\n\n';
    text += '下一步：\n';
    text += '1️⃣ 配置「监听群」（可多选）\n';
    text += '2️⃣ 配置「规则」\n';
    text += '3️⃣ 群内出现开奖即自动下注';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('👥 配置监听群', 'chat:main')],
      [Markup.button.callback('🏠 回主面板', 'dashboard:refresh')],
    ]);
    return { text, keyboard };
  }
}

module.exports = LoginPanel;
