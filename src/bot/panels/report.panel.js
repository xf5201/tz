// src/bot/panels/report.panel.js
const { Markup } = require('telegraf');
const { escapeHtml } = require('../../utils/format.util');

/**
 * 下注记录面板（ReportPanel）
 *
 * 只简单记：几点几分几秒、下注方向、金额、输赢；
 * 顶部汇总今日盈利（今日已结算注的盈亏合计）。
 */
class ReportPanel {
  static async render(ctx, data) {
    const text = this.buildText(data);
    const keyboard = this.buildKeyboard(data);
    return { text, keyboard };
  }

  static buildText({ todayProfit, bets = [], page = 0, total = 0 }) {
    // 今日盈利（正绿负红，HTML 不支持颜色，用符号区分）
    const profitText = todayProfit > 0
      ? `🟢 +${todayProfit}`
      : todayProfit < 0
        ? `🔴 ${todayProfit}`
        : `${todayProfit}`;

    let text = '📊 <b>下注记录</b>\n';
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += `💰 今日盈利：<b>${profitText}</b>\n`;
    text += `🎯 记录：${total} 条，第 ${page + 1} 页\n`;
    text += '━━━━━━━━━━━━━━━━━━━━\n';

    if (bets.length === 0) {
      text += '暂无下注记录。';
    }
    for (const b of bets) {
      // 时间去掉日期只留 时:分:秒
      const time = (b.created_at || '').split(' ')[1] || b.created_at;
      const dir = b.direction === 'BIG' ? '大' : '小';
      let result;
      if (b.status === 'DRY_RUN') {
        // 模拟注：按开奖点数判定，无盈亏金额
        result = b.is_win === 1 ? '🧪 赢（模拟）'
               : b.is_win === 0 ? '🧪 输（模拟）'
               : '🧪 模拟';
      } else if (b.is_win === 1) {
        result = `✅ 赢 ${b.profit != null ? b.profit : ''}`.trim();
      } else if (b.is_win === 0) {
        result = `❌ 输 ${b.profit != null ? b.profit : ''}`.trim();
      } else if (b.status === 'FAILED') {
        result = '⚠️ 发送失败';
      } else {
        result = '⏳ 待结算';
      }

      text += `${time}　${escapeHtml(dir)} ${escapeHtml(String(b.bet_amount))}　${result}\n`;
    }

    return text;
  }

  static buildKeyboard({ page = 0, total = 0 }) {
    const PAGE_SIZE = 10;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const buttons = [];

    const pagerRow = [];
    if (page > 0) pagerRow.push(Markup.button.callback('⬅️ 上一页', `report:page:${page - 1}`));
    pagerRow.push(Markup.button.callback(`${page + 1}/${totalPages}`, 'report:noop'));
    if (page < totalPages - 1) pagerRow.push(Markup.button.callback('下一页 ➡️', `report:page:${page + 1}`));
    buttons.push(pagerRow);

    buttons.push(
      [Markup.button.callback('🔄 刷新', 'report:main')],
      [Markup.button.callback('🔙 返回', 'dashboard:refresh')]
    );
    return Markup.inlineKeyboard(buttons);
  }
}

module.exports = ReportPanel;
