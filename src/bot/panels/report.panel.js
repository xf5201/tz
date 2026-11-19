// src/bot/panels/report.panel.js
const { Markup } = require('telegraf');
const { escapeHtml, shortTitle } = require('../../utils/format.util');
const { maskChatId } = require('../../utils/mask.util');

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

  static buildText({
    todayProfit, balanceProfit = null, bets = [], page = 0, total = 0,
    roundProfit = null, takeProfit = null,
  }) {
    // 盈利结论 = 当前余额 − 初始余额（2026-11-02 主人口径）；注单累计仅作参考
    const profitText = (b) => (b > 0 ? `🟢 +${b}` : b < 0 ? `🔴 ${b}` : `${b}`);
    const refText = todayProfit > 0 ? `+${todayProfit}` : `${todayProfit}`;

    let text = '📊 <b>下注记录</b>\n';
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    if (balanceProfit == null) {
      text += `💰 盈利：—（先点「🔍 初始化余额」设置基准）｜注单累计 ${refText}（参考）\n`;
    } else {
      text += `💰 盈利（余额−初始余额）：<b>${profitText(balanceProfit)}</b>\n`;
      text += `📝 注单累计（参考）：${refText}\n`;
    }

    // 本轮盈利（止盈判定用的那条线）：达到目标就停，手动恢复后清零重新算
    if (takeProfit != null) {
      const rp = Number(roundProfit) || 0;
      const rpText = rp > 0 ? `🟢 +${rp}` : rp < 0 ? `🔴 ${rp}` : `${rp}`;
      text += `🎯 本轮盈利：${rpText} / ${takeProfit}\n`;
    }

    text += `📋 记录：${total} 条，第 ${page + 1} 页\n`;
    text += '━━━━━━━━━━━━━━━━━━━━\n';

    if (bets.length === 0) {
      text += '暂无下注记录。';
    }
    for (const b of bets) {
      // 时间去掉日期只留 时:分:秒
      const time = (b.created_at || '').split(' ')[1] || b.created_at;
      const dir = require('../../core/rule.engine').directionLabel(b.direction);
      // 金额展示（2026-10-31）：定位胆显示「每注X×5总Y」，大小显示原金额，
      // 避免「定位胆1/2/3/4/5 50」被误读为每个号下 50
      const isSpecRow = !(b.direction === 'BIG' || b.direction === 'SMALL');
      const amountText = isSpecRow
        ? `每注${b.stake_per_number != null ? b.stake_per_number : Math.round(Number(b.bet_amount) / 5)}×5总${b.bet_amount}`
        : String(b.bet_amount);
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
        // 失败优先展示机器人给的原因（如「余额不足」），没有则退回通用文案
        result = b.error_msg
          ? `⚠️ ${escapeHtml(b.error_msg)}`
          : '⚠️ 发送失败';
      } else {
        result = '⏳ 待结算';
      }

      // 群名只取前 3 个字（一行要塞时间/方向/金额/输赢，位置有限）
      const chat = shortTitle(b.chat_title) || maskChatId(b.chat_id);
      text += `${time}　${escapeHtml(chat)}｜${escapeHtml(dir)} ${escapeHtml(amountText)}　${result}\n`;
    }

    return text;
  }

  static buildKeyboard({ page = 0, total = 0, todayCount = 0 }) {
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
      // 今日有记录时才给清空按钮（避免空点）
      [Markup.button.callback(
        todayCount > 0 ? `🗑 清空今日记录（${todayCount} 条）` : '🗑 清空今日记录（无记录）',
        'report:clear_today'
      )],
      [Markup.button.callback(
        total > 0 ? `🗑 删除全部记录（${total} 条）` : '🗑 删除全部记录（无记录）',
        'report:clear_all'
      )],
      [Markup.button.callback('🔙 返回', 'dashboard:refresh')]
    );
    return Markup.inlineKeyboard(buttons);
  }
}

module.exports = ReportPanel;
