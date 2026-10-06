// src/bot/panels/rule.panel.js
const { Markup } = require('telegraf');
const { truncate } = require('../../utils/format.util');
const { describeRule } = require('../../core/rule.engine');

/**
 * 规则配置面板（RulePanel，动态监测模型）
 *
 * 规则全程按钮化配置：只需设定「连续 N 次开出大/小 → 自动反向下注」的 N
 * 与金额参数；下注方向由系统自动取反，无需选择。
 * 规则作用于全部已勾选的监听群（无需重复选群）。
 *
 * 子面板（data.subPanel 区分）：
 *   list / wizard / streak / base / ratio / maxlose / stop / minint
 *
 * 向导草稿存于 panel_context.wizard_state：
 *   { scene: 'rule_wizard', draft: { editId, streak_count, base_bet,
 *     martingale_ratio, max_lose_streak, stop_loss, min_interval } }
 */
class RulePanel {
  static async render(ctx, data) {
    const subPanel = data.subPanel || 'list';
    switch (subPanel) {
      case 'wizard': return this.buildWizard(data);
      case 'streak': return this.buildPreset(data, 'streak');
      case 'base': return this.buildPreset(data, 'base');
      case 'ratio': return this.buildPreset(data, 'ratio');
      case 'maxlose': return this.buildPreset(data, 'maxlose');
      case 'stop': return this.buildPreset(data, 'stop');
      case 'minint': return this.buildPreset(data, 'minint');
      case 'list':
      default: return this.buildList(data);
    }
  }

  // ═══════════════════════════════════════════
  // 规则列表
  // ═══════════════════════════════════════════
  static buildList({ rules, stateByRule = {} }) {
    let text = '⚙️ <b>规则配置</b>\n';
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += `共 <b>${rules.length}</b> 条规则，点击可编辑：\n\n`;

    const buttons = [];
    if (rules.length === 0) {
      text += '还没有规则。新建一条只需：\n';
      text += '1️⃣ 设连续次数 N → 2️⃣ 设金额参数 → 3️⃣ 保存\n';
      text += '规则自动作用于全部已勾选的监听群。';
    }

    for (const rule of rules) {
      const state = rule.enabled ? '🟢' : '⚪';
      const dry = rule.dry_run ? '🧪' : '';
      text += `${state}${dry} <b>${truncate(rule.name || `规则${rule.id}`, 18)}</b>\n`;
      text += `   ${describeRule(rule)}\n`;
      text += `   基础 ${rule.base_bet} × ${rule.martingale_ratio}｜连败上限 ${rule.max_lose_streak}｜${rule.stop_loss != null ? `止损 ${rule.stop_loss}` : '不限止损'}\n`;
      text += `   模式：${rule.dry_run ? '🧪 模拟（只记录）' : '📤 实发'}\n`;
      const states = stateByRule[rule.id] || [];
      if (states.length > 0) {
        const losses = states.map((s) => s.consecutive_losses);
        const pending = states.filter((s) => s.pending_direction).length;
        const armed = states.filter((s) => s.armed_direction).length;
        text += `   各群连败 ${Math.max(...losses)}（最多）｜待发 ${armed} 群｜挂起 ${pending} 群\n`;
      }
      text += '\n';
      buttons.push([Markup.button.callback(
        `${state}${dry} 连${rule.streak_count}把反买｜基础${rule.base_bet}｜${rule.martingale_ratio}x`,
        `rule:edit:${rule.id}`
      )]);
    }

    buttons.push(
      [Markup.button.callback('🆕 新建规则', 'rule:new')],
      [Markup.button.callback('🔙 返回', 'dashboard:refresh')]
    );
    return { text, keyboard: Markup.inlineKeyboard(buttons) };
  }

  // ═══════════════════════════════════════════
  // 向导主界面（草稿摘要 + 分项按钮）
  // ═══════════════════════════════════════════
  static buildWizard({ draft = {} }) {
    const isEdit = draft.editId != null;
    let text = `${isEdit ? '✏️ 编辑规则' : '🆕 新建规则'}（逐项点击下方按钮）\n`;
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += `🎲 模式：动态监测\n`;
    text += `🔢 连续次数：${draft.streak_count ?? '⬜'} 把\n`;
    text += `💡 触发：连续 N 把开「大」→ 自动买「小」\n`;
    text += `💡 　　　连续 N 把开「小」→ 自动买「大」\n`;
    text += `👥 作用范围：全部已勾选的监听群\n`;
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += `💰 金额：${draft.base_bet ?? '⬜'}\n`;
    text += `📈 倍投：${draft.martingale_ratio ? `${draft.martingale_ratio}x` : '⬜'}\n`;
    text += `🛑 连败上限：${draft.max_lose_streak ?? '⬜'}\n`;
    text += `⚖️ 止损上限：${draft.stop_loss != null ? draft.stop_loss : '不限'}\n`;
    text += `⏱ 最小间隔：${draft.min_interval ?? 3}s\n`;
    text += `🧪 模式：${draft.dry_run ? '模拟（只记录不发送）' : '📤 实发'}\n`;
    text += '━━━━━━━━━━━━━━━━━━━━\n';

    const buttons = [
      [Markup.button.callback(`🔢 连续次数：${draft.streak_count ?? '?'}`, 'rule:w_streak')],
      [Markup.button.callback(`💰 金额：${draft.base_bet ?? '?'}`, 'rule:w_base')],
      [Markup.button.callback(`📈 倍投：${draft.martingale_ratio ? draft.martingale_ratio + 'x' : '?'}`, 'rule:w_ratio')],
      [
        Markup.button.callback(`🛑 连败：${draft.max_lose_streak ?? '?'}`, 'rule:w_maxlose'),
        Markup.button.callback(`⚖️ 止损：${draft.stop_loss != null ? draft.stop_loss : '不限'}`, 'rule:w_stop'),
        Markup.button.callback(`⏱ 间隔：${draft.min_interval ?? 3}s`, 'rule:w_minint'),
      ],
      [Markup.button.callback(
        draft.dry_run ? '🧪 模拟模式：开（点击切换为实发）' : '📤 实发模式：开（点击切换为模拟）',
        'rule:w_dry'
      )],
    ];

    if (isEdit) {
      const stateText = draft.enabled ? '⏸ 停用' : '▶️ 启用';
      buttons.push(
        [Markup.button.callback(stateText, `rule:toggle:${draft.editId}`)],
        [Markup.button.callback('🗑 删除规则', `rule:del:${draft.editId}`)]
      );
    }

    buttons.push(
      [Markup.button.callback('✅ 保存规则', 'rule:w_confirm')],
      [Markup.button.callback('❎ 取消', 'rule:w_cancel')]
    );
    return { text, keyboard: Markup.inlineKeyboard(buttons) };
  }

  // ═══════════════════════════════════════════
  // 数值预设选择（连续次数/金额/倍投/连败/止损/间隔）
  // ═══════════════════════════════════════════
  static buildPreset({ draft = {} }, kind) {
    const config = {
      streak: {
        title: '🔢 连续次数 N',
        desc: '同一监听群连续 N 把开出「大」→ 自动买「小」；连续 N 把开「小」→ 自动买「大」',
        presets: [['3 把', '3'], ['4 把', '4'], ['5 把', '5'], ['6 把', '6']],
        presets2: [['8 把', '8'], ['10 把', '10'], ['12 把', '12'], ['15 把', '15']],
        callback: 'rule:w_streak_count',
        custom: 'rule:w_streak_custom',
        current: draft.streak_count,
      },
      base: {
        title: '💰 基础下注金额',
        desc: '连败时的下注金额 = 基础金额 × 倍投比例^连败次数',
        presets: [['10', '10'], ['50', '50'], ['100', '100'], ['500', '500']],
        callback: 'rule:w_base',
        custom: 'rule:w_base_custom',
        current: draft.base_bet,
      },
      ratio: {
        title: '📈 倍投比例',
        desc: '连败一次后金额 = 基础金额 × 比例，再败继续乘',
        presets: [['1.5x', '1.5'], ['2.0x', '2.0'], ['2.5x', '2.5'], ['3.0x', '3.0']],
        callback: 'rule:w_ratio',
        custom: 'rule:w_ratio_custom',
        current: draft.martingale_ratio ? `${draft.martingale_ratio}x` : null,
      },
      maxlose: {
        title: '🛑 连败上限',
        desc: '连续未中达到该次数，规则自动停用并通知（需人工启用）',
        presets: [['3 次', '3'], ['5 次', '5'], ['6 次', '6'], ['10 次', '10']],
        callback: 'rule:w_maxlose',
        custom: 'rule:w_maxlose_custom',
        current: draft.max_lose_streak,
      },
      stop: {
        title: '⚖️ 止损上限',
        desc: '当前连败的累计投入达到该金额时，规则自动停用并通知',
        presets: [['200', '200'], ['500', '500'], ['1000', '1000'], ['5000', '5000']],
        callback: 'rule:w_stop',
        custom: 'rule:w_stop_custom',
        extra: [Markup.button.callback('🚫 不设止损', 'rule:w_stop_none')],
        current: draft.stop_loss != null ? draft.stop_loss : '不限',
      },
      minint: {
        title: '⏱ 同群最小动作间隔（秒）',
        desc: '两次下注之间强制间隔，防止密集发送',
        presets: [['0 秒', '0'], ['3 秒', '3'], ['5 秒', '5'], ['10 秒', '10']],
        callback: 'rule:w_minint',
        custom: 'rule:w_minint_custom',
        current: draft.min_interval ?? 3,
      },
    }[kind];

    let text = `${config.title}\n`;
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += `${config.desc}\n`;
    if (config.current != null) text += `当前：${config.current}`;

    const rows = [];
    rows.push(config.presets.map(([label, value]) =>
      Markup.button.callback(label, `${config.callback}:${value}`)
    ));
    if (config.presets2) {
      rows.push(config.presets2.map(([label, value]) =>
        Markup.button.callback(label, `${config.callback}:${value}`)
      ));
    }
    if (config.custom) {
      rows.push([Markup.button.callback('🔢 自定义输入', config.custom)]);
    }
    if (config.extra) {
      for (const btn of config.extra) rows.push([btn]);
    }
    rows.push([Markup.button.callback('🔙 返回向导', 'rule:w_back')]);
    return { text, keyboard: Markup.inlineKeyboard(rows) };
  }
}

module.exports = RulePanel;
