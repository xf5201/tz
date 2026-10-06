// src/bot/panels/dashboard.panel.js
const { Markup } = require('telegraf');
const { maskPhone, maskChatId } = require('../../utils/mask.util');
const { formatNumber } = require('../../utils/format.util');
// 余额是否不足以继续下注（与策略执行器同一口径）
const { isBalanceInsufficient } = require('../../core/rule.engine');

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
    user, account, chats, rules, throughput, todayProfit, latestFailed,
    blockedChats = [], roundProfit = null,
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

      // 余额见底 → 全局停注提示
      if (isBalanceInsufficient(account.balance, rules)) {
        text += '🛑 余额不足，已全局停注（充值后自动恢复）\n';
      }

      // 亏损进度（相对初始余额）
      if (account.initial_balance != null && Number(account.initial_balance) > 0) {
        const initial = Number(account.initial_balance);
        const balance = Number(account.balance);
        const diff = balance - initial;
        const pct = ((diff / initial) * 100).toFixed(1);
        const sign = diff > 0 ? '+' : '';
        text += `🎯 初始余额：${formatNumber(initial)}（${sign}${pct}%｜${sign}${formatNumber(diff)}）\n`;
        if (account.alert_enabled === 1 && balance < initial / 2) {
          text += '📉 已跌破初始余额一半，注意风险\n';
        }
      }
    } else {
      text += '💳 当前余额：—（等待下注回复）\n';
    }

    // 今日盈利（今日已结算注的盈亏合计）
    if (todayProfit != null) {
      const p = Number(todayProfit);
      const profitText = p > 0 ? `🟢 +${p}` : p < 0 ? `🔴 ${p}` : `${p}`;
      text += `📈 今日盈利：${profitText}\n`;
    }

    // 止盈：设置了目标就显示本轮盈利进度；达标停止后给出醒目提示
    if (account.take_profit != null) {
      const rp = Number(roundProfit) || 0;
      const rpText = rp > 0 ? `🟢 +${rp}` : rp < 0 ? `🔴 ${rp}` : `${rp}`;
      text += `🎯 本轮盈利：${rpText} / ${account.take_profit}\n`;
    }
    if (account.profit_stopped === 1) {
      text += '🟡 <b>已达止盈目标，已停止运行</b>\n';
      text += '　 点下方「▶️ 恢复运行」才会继续（本轮盈利清零重算）\n';
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

      // 止盈：达标停止后给「恢复运行」；否则给「设置目标」
      if (account.profit_stopped === 1) {
        buttons.push([Markup.button.callback('▶️ 恢复运行（本轮盈利清零）', 'dashboard:resume_profit')]);
      }
      buttons.push([Markup.button.callback(
        account.take_profit != null
          ? `🎯 止盈目标：${account.take_profit}（点击修改/关闭）`
          : '🎯 设置今日止盈目标',
        'dashboard:take_profit'
      )]);

      // 亏损预警：开关 + 基准重置
      // 亏损超过初始余额一半时主动发消息告警（需余额已解析到才有意义）
      if (account.balance != null) {
        buttons.push([Markup.button.callback(
          account.alert_enabled ? '📉 亏损预警：开（点击关闭）' : '📉 亏损预警：关（点击开启）',
          'dashboard:alert_toggle'
        )]);
        if (account.alert_enabled) {
          buttons.push([Markup.button.callback(
            `🎯 重置亏损基准（当前 ${formatNumber(account.balance)}）`,
            'dashboard:alert_reset'
          )]);
        }
      }

      // 主动查余额：往群里发「余额」问一次（充值后不用重启就能恢复）
      buttons.push([Markup.button.callback('🔍 查询余额', 'dashboard:query_balance')]);

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

