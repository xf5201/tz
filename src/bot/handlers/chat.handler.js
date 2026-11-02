// src/bot/handlers/chat.handler.js
const { getPeerId } = require('telegram/Utils');

const monitoredChatDao = require('../../db/monitored-chat.dao');
const panelContextDao = require('../../db/panel-context.dao');
const logger = require('../../utils/logger');
const { maskChatId } = require('../../utils/mask.util');

/**
 * 监听群配置回调处理（多群多选）
 *
 * 支持回调：
 *   chat:main             → 配置入口
 *   chat:list[:page]      → 群列表多选
 *   chat:toggle:{chatId}  → 切换某群的勾选状态
 *   chat:page:{n}         → 翻页
 *   chat:page_all:{p}     → 全选本页
 *   chat:clear            → 清空勾选
 *   chat:search           → 搜索群名（input scene）
 *   chat:refresh          → 强制重新拉取列表
 *   chat:save             → 确认监听（热更新）
 *   chat:noop
 */

// 对话列表缓存：botUserId → { chats, ts }（避免频繁 getDialogs）
const _dialogCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// 列表分页大小（与面板保持一致）
const PAGE_SIZE = 10;

class ChatHandler {
  static async handle(ctx, action, params, { panelRenderer, services }) {
    const botUserId = String(ctx.from.id);

    switch (action) {
      case 'main':
        await this.handleMain(ctx, botUserId, { panelRenderer });
        break;

      case 'list':
        await this.handleList(ctx, botUserId, parseInt(params[0], 10) || 0, false, { panelRenderer, services });
        break;

      case 'toggle':
        await this.handleToggle(ctx, botUserId, params[0], { panelRenderer, services });
        break;

      case 'page':
        await this.handlePage(ctx, botUserId, parseInt(params[0], 10) || 0, { panelRenderer, services });
        break;

      case 'page_all':
        await this.handlePageAll(ctx, botUserId, parseInt(params[0], 10) || 0, { panelRenderer, services });
        break;

      case 'clear':
        await this.handleClear(ctx, botUserId, { panelRenderer, services });
        break;

      case 'search':
        await ctx.scene.enter('input', { field: 'chat_keyword' });
        break;

      case 'refresh':
        _dialogCache.delete(botUserId);
        await this.handleList(ctx, botUserId, 0, true, { panelRenderer, services });
        break;

      case 'save':
        await this.handleSave(ctx, botUserId, { panelRenderer, services });
        break;

      case 'noop':
        break;

      default:
        logger.warn(`[CHAT] 未知操作: ${action}`);
    }
  }

  /**
   * 拉取账号的群列表（带缓存）
   */
  static async fetchGroups(botUserId, services, force = false) {
    const cached = _dialogCache.get(botUserId);
    if (!force && cached && Date.now() - cached.ts < CACHE_TTL) {
      return cached.chats;
    }

    const client = services.session.getClient(botUserId);
    if (!client) {
      throw new Error('账号未连接，请重新登录');
    }

    const dialogs = await client.getDialogs({ limit: 200 });
    const chats = dialogs
      .filter((d) => d.isGroup || d.isChannel)
      .map((d) => ({
        chat_id: safePeerId(d),
        chat_title: d.title ?? d.name ?? '(未命名)',
        chat_type: d.isChannel ? 'channel' : 'group',
      }))
      .filter((c) => c.chat_id && c.chat_id.startsWith('-')); // 仅保留群/频道

    _dialogCache.set(botUserId, { chats, ts: Date.now() });
    logger.info(`[CHAT] 用户 ${botUserId} 拉取对话列表: ${chats.length} 个群`);
    return chats;
  }

  /**
   * 读取 / 初始化多选状态（wizard_state）
   */
  static _loadState(ctx, botUserId) {
    const panelCtx = ctx.panelContext;
    if (panelCtx && panelCtx.wizard_state) {
      try {
        const state = JSON.parse(panelCtx.wizard_state);
        if (state.scene === 'chat_select') return state;
      } catch (_) { /* 忽略 */ }
    }
    // 初始化：以当前生效的监听群作为已选
    const saved = monitoredChatDao.listByUser(botUserId);
    return {
      scene: 'chat_select',
      selected: saved.map((c) => c.chat_id),
      page: 0,
      keyword: '',
    };
  }

  static _saveState(botUserId, state) {
    panelContextDao.updateWizardState(botUserId, JSON.stringify(state));
  }

  static async handleMain(ctx, botUserId, { panelRenderer }) {
    const chats = monitoredChatDao.listByUser(botUserId);
    await panelRenderer.render(ctx, 'chat_main', { chats });
  }

  static async handleList(ctx, botUserId, page, force, { panelRenderer, services }) {
    const allChats = await this.fetchGroups(botUserId, services, force);
    const state = this._loadState(ctx, botUserId);
    state.page = page;
    this._saveState(botUserId, state);

    await panelRenderer.render(ctx, 'chat_list', {
      allChats,
      selected: state.selected,
      page: state.page,
      keyword: state.keyword,
      savedCount: monitoredChatDao.countByUser(botUserId),
    });
  }

  static async handleToggle(ctx, botUserId, chatId, { panelRenderer, services }) {
    const allChats = await this.fetchGroups(botUserId, services);
    const state = this._loadState(ctx, botUserId);

    const idx = state.selected.indexOf(chatId);
    if (idx >= 0) state.selected.splice(idx, 1);
    else state.selected.push(chatId);
    this._saveState(botUserId, state);

    await panelRenderer.render(ctx, 'chat_list', {
      allChats,
      selected: state.selected,
      page: state.page,
      keyword: state.keyword,
      savedCount: monitoredChatDao.countByUser(botUserId),
    });
  }

  static async handlePage(ctx, botUserId, page, { panelRenderer, services }) {
    await this.handleList(ctx, botUserId, page, false, { panelRenderer, services });
  }

  static async handlePageAll(ctx, botUserId, page, { panelRenderer, services }) {
    const allChats = await this.fetchGroups(botUserId, services);
    const state = this._loadState(ctx, botUserId);

    // 与面板同样的过滤与分页逻辑，全选当前页
    const kw = (state.keyword || '').trim().toLowerCase();
    const filtered = kw
      ? allChats.filter((c) => (c.chat_title || '').toLowerCase().includes(kw))
      : allChats;
    const slice = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    for (const c of slice) {
      if (!state.selected.includes(c.chat_id)) state.selected.push(c.chat_id);
    }
    state.page = page;
    this._saveState(botUserId, state);

    await panelRenderer.render(ctx, 'chat_list', {
      allChats,
      selected: state.selected,
      page: state.page,
      keyword: state.keyword,
      savedCount: monitoredChatDao.countByUser(botUserId),
    });
  }

  static async handleClear(ctx, botUserId, { panelRenderer, services }) {
    const allChats = await this.fetchGroups(botUserId, services);
    const state = this._loadState(ctx, botUserId);
    state.selected = [];
    this._saveState(botUserId, state);

    await panelRenderer.render(ctx, 'chat_list', {
      allChats,
      selected: [],
      page: state.page,
      keyword: state.keyword,
      savedCount: monitoredChatDao.countByUser(botUserId),
    });
  }

  static async handleSave(ctx, botUserId, { panelRenderer, services }) {
    const state = this._loadState(ctx, botUserId);
    if (state.selected.length === 0) {
      throw new Error('尚未勾选任何群，请先点选群再确认');
    }

    const allChats = await this.fetchGroups(botUserId, services);
    const byId = new Map(allChats.map((c) => [c.chat_id, c]));

    // 已选但不在缓存里的（如手动配置过），从库中补齐信息
    const saved = monitoredChatDao.listByUser(botUserId);
    for (const s of saved) byId.set(s.chat_id, { chat_id: s.chat_id, chat_title: s.chat_title, chat_type: s.chat_type });

    const chats = state.selected
      .map((id) => byId.get(id))
      .filter(Boolean);

    const count = services.account.saveMonitoredChats(botUserId, chats);
    services.listener.invalidateChatsCache(botUserId);
    panelContextDao.clearWizardState(botUserId);

    await panelRenderer.render(ctx, 'chat_saved', { count });
  }
}

/**
 * 取 marked 群 ID（频道/超级群形如 -1001234567890）
 */
function safePeerId(dialog) {
  try {
    return getPeerId(dialog.entity, true);
  } catch (_) {
    return String(dialog?.id ?? '');
  }
}

module.exports = ChatHandler;
