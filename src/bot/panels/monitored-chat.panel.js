// src/bot/panels/monitored-chat.panel.js
const { Markup } = require('telegraf');
const { truncate } = require('../../utils/format.util');

/**
 * 监听群配置面板（MonitoredChatPanel）
 *
 * 与 pc28 的 target-chat 面板不同：支持【多选】监听群。
 * 子面板（data.subPanel 区分）：
 *   main   → 配置入口说明
 *   list   → 群列表多选（每群一个 ✅/⬜ 切换按钮 + 分页 + 全选本页/清空 + 确认）
 *   saved  → 保存成功
 *
 * 勾选状态存于 panel_context.wizard_state：
 *   { scene: 'chat_select', selected: string[], page: number, keyword: string }
 */
class MonitoredChatPanel {
  static async render(ctx, data) {
    const subPanel = data.subPanel || 'main';

    switch (subPanel) {
      case 'list': return this.buildList(data);
      case 'saved': return this.buildSaved(data);
      case 'main':
      default: return this.buildMain(data);
    }
  }

  // ── 配置入口 ──
  static buildMain({ chats }) {
    let text = '👥 <b>监听群配置</b>\n';
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += `当前已选：<b>${chats ? chats.length : 0}</b> 个群\n`;
    if (chats && chats.length > 0) {
      for (const c of chats.slice(0, 10)) {
        text += `   ✅ ${truncate(c.chat_title || c.chat_id, 24)}\n`;
      }
      if (chats.length > 10) text += `   …等共 ${chats.length} 个\n`;
    }
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += '💡 从列表勾选要监听的群（可多选），\n点击「确认监听」后立即生效，无需重启。';

    const buttons = [
      [Markup.button.callback('📋 从列表选择', 'chat:list:0')],
      [Markup.button.callback('🔄 刷新列表', 'chat:refresh')],
      [Markup.button.callback('🔙 返回', 'dashboard:refresh')],
    ];
    return { text, keyboard: Markup.inlineKeyboard(buttons) };
  }

  // ── 群列表多选 ──
  static buildList({ allChats, selected = [], page = 0, keyword = '', savedCount = 0 }) {
    const selectedSet = new Set(selected);
    const kw = (keyword || '').trim().toLowerCase();
    const filtered = kw
      ? allChats.filter((c) => (c.chat_title || '').toLowerCase().includes(kw))
      : allChats;

    const PAGE_SIZE = 10;
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const p = Math.min(Math.max(0, page), totalPages - 1);
    const slice = filtered.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);

    let text = '📋 <b>选择监听群</b>（点击切换 ✅/⬜）\n';
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += `已选 <b>${selected.length}</b> 个`;
    if (savedCount > 0) text += `（当前生效 ${savedCount} 个）`;
    text += '\n';
    if (kw) text += `🔍 关键词：${keyword}\n`;
    text += `共 ${filtered.length} 个群，第 ${p + 1}/${totalPages} 页\n`;
    text += '━━━━━━━━━━━━━━━━━━━━\n';

    const buttons = [];
    for (const c of slice) {
      const mark = selectedSet.has(c.chat_id) ? '✅' : '⬜';
      buttons.push([Markup.button.callback(
        `${mark} ${truncate(c.chat_title || c.chat_id, 24)}`,
        `chat:toggle:${c.chat_id}`
      )]);
    }

    if (filtered.length === 0) {
      text += '未找到群：请确认账号已在群中，或点「刷新列表」。';
    }

    // 批量操作 + 分页
    const navRow = [];
    if (p > 0) navRow.push(Markup.button.callback('⬅️ 上一页', `chat:page:${p - 1}`));
    navRow.push(Markup.button.callback(`${p + 1}/${totalPages}`, 'chat:noop'));
    if (p < totalPages - 1) navRow.push(Markup.button.callback('下一页 ➡️', `chat:page:${p + 1}`));

    buttons.push(
      [
        Markup.button.callback('✅ 全选本页', `chat:page_all:${p}`),
        Markup.button.callback('🗑 清空', 'chat:clear'),
      ],
      [Markup.button.callback('🔍 搜索群名', 'chat:search')],
      navRow,
      [Markup.button.callback(`✔️ 确认监听（已选 ${selected.length}）`, 'chat:save')],
      [Markup.button.callback('🔙 返回', 'chat:main')]
    );

    return { text, keyboard: Markup.inlineKeyboard(buttons) };
  }

  // ── 保存成功 ──
  static buildSaved({ count }) {
    let text = '✅ <b>监听配置已保存</b>\n';
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += `已开始监听 <b>${count}</b> 个群（热更新生效）\n`;
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += '下一步：配置「规则」，群内出现开奖即自动下注。';

    const buttons = [
      [Markup.button.callback('⚙️ 去配置规则', 'rule:list')],
      [Markup.button.callback('🏠 回主面板', 'dashboard:refresh')],
    ];
    return { text, keyboard: Markup.inlineKeyboard(buttons) };
  }
}

module.exports = MonitoredChatPanel;
