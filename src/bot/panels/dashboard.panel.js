// src/bot/panels/dashboard.panel.js
const { Markup } = require('telegraf');
const { maskPhone, maskChatId } = require('../../utils/mask.util');
const { formatNumber } = require('../../utils/format.util');

/**
 * 主面板（DashboardPanel）
 */
class DashboardPanel {
  static async render(ctx, data) {
    const text = this.buildText(data);
    const keyboard = this.buildKeyboard(data);
    return { text, keyboard };
  }

  static buildText({
    user, account, chats, rules, throughput, todayProfit, latestFailed, blockedChats = [],
  }) {
    let text = '🎲 <b>TG 群监听下注助手</b>\n';
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += `👤 用户：@${user.username || user.id}\n`;

    if (!account) {
      text += '🤖 账号：🔴 未登录\n';
      text += '━━━━━━━━━━━━━━━━━━━━\n';
      return text;
    }

    text += `📱 账号：${maskPhone(account.phone)}\n`;
    text += `🤖 状态：${this.statusIcon(account.status)} ${this.statusText(account.status)}\n`;
    text += `🔊 监听：${account.listen_enabled ? '🟢 开启' : '⚪ 已暂停'}\n`;
    text += `👥 监听群：${chats ? chats.length : 0} 个\n`;

    // 当前余额（机器人对本账号下注的回复消息解析得到）
    if (account.balance != null) {
      const updated = account.balance_updated_at
        ? (account.balance_updated_at.split(' ')[1] || '')
        : '';
      text += `💳 当前余额：<b>${formatNumber(account.balance)}</b>${updated ? `（${updated}）` : ''}\n`;
    } else {
      text += '💳 当前余额：—（等待下注回复）\n';
    }

    // 今日盈利（今日已结算注的盈亏合计）
    if (todayProfit != null) {
      const p = Number(todayProfit);
      const profitText = p > 0 ? `🟢 +${p}` : p < 0 ? `🔴 ${p}` : `${p}`;
      text += `📈 今日盈利：${profitText}\n`;
    }

    // 被单独停注的群（连败 / 止损达上限，等下次触发自动恢复）
    if (blockedChats.length > 0) {
      text += `⛔ 停注群：${blockedChats.length} 个（等待下次触发自动恢复）\n`;
      for (const b of blockedChats.slice(0, 3)) {
        text += `   ${b.chat_title || maskChatId(b.chat_id)}｜${b.blocked_reason || '已停注'}\n`;
      }
      if (blockedChats.length > 3) text += `   …等共 ${blockedChats.length} 个\n`;
    }

    if (rules && rules.length > 0) {
      const enabled = rules.filter((r) => r.enabled === 1);
      text += `📌 规则：${enabled.length}/${rules.length} 条启用\n`;
      for (const rule of enabled.slice(0, 5)) {
        const mode = rule.dry_run ? '🧪模拟' : '📤实发';
        text += `   ${mode}·连${rule.streak_count}把反买（基础 ${rule.base_bet} × ${rule.martingale_ratio}）\n`;
      }
      if (enabled.length > 5) text += `   …等共 ${enabled.length} 条\n`;
    } else {
      text += '📌 规则：未配置\n';
    }

    text += `⚡ 近10分钟开奖：${throughput ?? 0} 条\n`;

    if (latestFailed) {
      text += `⚠️ 最近失败：${latestFailed}\n`;
    }

    text += '━━━━━━━━━━━━━━━━━━━━\n';
    return text;
  }

  static buildKeyboard({ account, blockedChats = [] }) {
    const buttons = [];

    if (!account) {
      // 未登录状态
      buttons.push([Markup.button.callback('➕ 登录执行账号', 'account:login')]);
    } else {
      // 已登录状态
      buttons.push(
        [Markup.button.callback('👥 监听群配置', 'chat:main')],
        [Markup.button.callback('⚙️ 规则配置', 'rule:list')],
        [
          Markup.button.callback(
            account.listen_enabled ? '🔊 监听中（点击暂停）' : '🔇 已暂停（点击开启）',
            'account:listen_toggle'
          ),
        ]
      );
      // 有停注群时才出现「立即恢复」（否则按钮点了没反应，徒增困惑）
      if (blockedChats.length > 0) {
        buttons.push([Markup.button.callback(
          `▶️ 立即恢复 ${blockedChats.length} 个停注群`, 'dashboard:resume_chats'
        )]);
      }
      buttons.push([Markup.button.callback('🗑️ 删除账号', 'account:delete_confirm')]);
    }

    // 公共底部按钮
    buttons.push(
      [Markup.button.callback('📊 下注记录', 'report:main')],
      [Markup.button.callback('🔄 刷新', 'dashboard:refresh')]
    );

    return Markup.inlineKeyboard(buttons);
  }

  /**
   * 规则一句话描述（动态监测模型）
   */
  static ruleDesc(rule) {
    return `连${rule.streak_count}把反买`;
  }

  static statusIcon(status) {
    return {
      PENDING_SETUP: '🟡',
      ACTIVE: '🟢',
      ERROR: '🔴',
      LOGGED_OUT: '⚪',
      DELETED: '⚫',
    }[status] || '⚪';
  }

  static statusText(status) {
    return {
      PENDING_SETUP: '待配置监听群',
      ACTIVE: '运行中',
      ERROR: '异常',
      LOGGED_OUT: '已退出',
      DELETED: '已删除',
    }[status] || '未知';
  }
}

module.exports = DashboardPanel;

