// src/bot/panels/account.panel.js
const { Markup } = require('telegraf');
const { maskPhone } = require('../../utils/mask.util');
const { formatDbTime } = require('../../utils/format.util');

/**
 * 账号面板（AccountPanel）
 */
class AccountPanel {
  static async render(ctx, data) {
    const text = this.buildText(data);
    const keyboard = this.buildKeyboard(data);
    return { text, keyboard };
  }

  static buildText({ account, chatCount, ruleCount }) {
    let text = '👤 <b>账号管理</b>\n';
    text += '━━━━━━━━━━━━━━━━━━━━\n';

    if (!account) {
      text += '🔴 尚未登录执行账号\n';
      text += '━━━━━━━━━━━━━━━━━━━━\n';
      text += '点击下方「登录执行账号」开始：\n';
      text += '1️⃣ 输入手机号（含国际区号）\n';
      text += '2️⃣ 输入短信验证码\n';
      text += '3️⃣ 如开启二步验证，输入云密码\n';
      return text;
    }

    text += `📱 手机号：${maskPhone(account.phone)}\n`;
    text += `🤖 状态：${account.status}\n`;
    text += `🔊 监听：${account.listen_enabled ? '🟢 开启' : '⚪ 暂停'}\n`;
    text += `👥 监听群：${chatCount ?? 0} 个\n`;
    text += `📌 规则：${ruleCount ?? 0} 条\n`;
    text += `🕓 更新时间：${formatDbTime(account.updated_at)}\n`;
    if (account.last_error) {
      text += `⚠️ 最近错误：${account.last_error}\n`;
    }
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += '💡 退出登录保留数据，可再次免验证恢复\n';
    return text;
  }

  static buildKeyboard({ account }) {
    const buttons = [];

    if (!account) {
      buttons.push(
        [Markup.button.callback('➕ 登录执行账号', 'account:login')],
        [Markup.button.callback('🔙 返回', 'dashboard:refresh')]
      );
      return Markup.inlineKeyboard(buttons);
    }

    buttons.push(
      [Markup.button.callback('🚪 退出登录（保留数据）', 'account:logout_confirm')],
      [Markup.button.callback('🗑️ 删除账号（不可恢复）', 'account:delete_confirm')],
      [Markup.button.callback('🔙 返回', 'dashboard:refresh')]
    );
    return Markup.inlineKeyboard(buttons);
  }
}

module.exports = AccountPanel;
