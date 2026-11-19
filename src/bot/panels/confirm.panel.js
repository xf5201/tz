// src/bot/panels/confirm.panel.js
const { Markup } = require('telegraf');

/**
 * 确认对话框面板（ConfirmPanel）
 *
 * 通用确认面板，通过 data.confirmCallback / data.cancelCallback
 * 自定义确认与取消后的回调地址；通过 data.title/message 定制文案。
 */
class ConfirmPanel {
  static async render(ctx, data) {
    const text = this.buildText(data);
    const keyboard = this.buildKeyboard(data);
    return { text, keyboard };
  }

  static buildText({ title, message }) {
    let text = `⚠️ <b>${title || '确认操作'}</b>\n`;
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += `${message || '确定要执行此操作吗？'}\n`;
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += '⛔ 请确认后再操作，此步骤为最后确认';
    return text;
  }

  static buildKeyboard({ confirmCallback, cancelCallback }) {
    const buttons = [
      [Markup.button.callback('✅ 确认执行', confirmCallback || 'dashboard:refresh')],
      [Markup.button.callback('❎ 取消', cancelCallback || 'dashboard:refresh')],
    ];
    return Markup.inlineKeyboard(buttons);
  }
}

module.exports = ConfirmPanel;
