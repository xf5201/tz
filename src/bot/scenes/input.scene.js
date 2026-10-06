// src/bot/scenes/input.scene.js
const { Scenes } = require('telegraf');
const panelContextDao = require('../../db/panel-context.dao');
const monitoredChatDao = require('../../db/monitored-chat.dao');
const accountDao = require('../../db/account.dao');
const actionLogDao = require('../../db/action-log.dao');
const operationLogDao = require('../../db/operation-log.dao');
const logger = require('../../utils/logger');

/**
 * 自定义输入 WizardScene
 *
 * 用途（仅限无法按钮化的例外项，与 pc28 的 input scene 同构）：
 *   - 规则向导中的数值自定义（基础金额/倍投比例/连败上限/止损上限/最小间隔）
 *   - 监听群列表的群名关键词搜索
 *
 * 核心原则：单消息模式
 *   - 不发送新消息，始终编辑当前面板消息
 *   - 输入完成后直接渲染回原面板
 */

const FIELD_CONFIG = {
  // ── 规则向导：数值自定义（写入 wizard_state.draft）──
  streak: {
    label: '连续次数 N',
    prompt: '请输入连续次数 N（2–50 的整数，连续 N 把开出大/小即反向下注，例如：5、8、10）',
    validate: (value) => {
      const num = parseInt(value, 10);
      if (isNaN(num) || String(num) !== value.trim()) return '请输入有效的正整数';
      if (num < 2 || num > 50) return '连续次数需为 2–50';
      return null;
    },
    parse: (value) => parseInt(value, 10),
    apply: (draft, value) => { draft.streak_count = value; },
    format: (value) => `${value} 把`,
    returnPanel: 'rule_wizard',
  },

  base: {
    label: '基础下注金额',
    prompt: '请输入基础下注金额（正整数，1–100000，例如：10、50、100、500）',
    validate: (value) => {
      const num = parseInt(value, 10);
      if (isNaN(num) || String(num) !== value.trim()) return '请输入有效的正整数';
      if (num < 1) return '基础下注金额必须 ≥ 1';
      if (num > 100000) return '基础下注金额不能超过 100000';
      return null;
    },
    parse: (value) => parseInt(value, 10),
    apply: (draft, value) => { draft.base_bet = value; },
    format: (value) => `${value}`,
    returnPanel: 'rule_wizard',
  },

  ratio: {
    label: '倍投比例',
    prompt: '请输入倍投比例（≥ 1.0 且 ≤ 10.0，例如：1.5、2.0、2.5、3.0）',
    validate: (value) => {
      const num = parseFloat(value);
      if (isNaN(num)) return '请输入有效的数字';
      if (num < 1.0) return '倍投比例必须 ≥ 1.0';
      if (num > 10.0) return '倍投比例不能超过 10.0';
      return null;
    },
    parse: (value) => parseFloat(value),
    apply: (draft, value) => { draft.martingale_ratio = value; },
    format: (value) => `${value}x`,
    returnPanel: 'rule_wizard',
  },

  maxlose: {
    label: '连败上限',
    prompt: '请输入连败上限（1–50，达到后规则自动停用并通知，例如：5、6、10）',
    validate: (value) => {
      const num = parseInt(value, 10);
      if (isNaN(num) || String(num) !== value.trim()) return '请输入有效的正整数';
      if (num < 1 || num > 50) return '连败上限需为 1–50';
      return null;
    },
    parse: (value) => parseInt(value, 10),
    apply: (draft, value) => { draft.max_lose_streak = value; },
    format: (value) => `${value} 次`,
    returnPanel: 'rule_wizard',
  },

  stop: {
    label: '止损上限',
    prompt: '请输入止损上限（正数，连败累计投入达到即停用，例如：200、500、1000）',
    validate: (value) => {
      const num = parseFloat(value);
      if (isNaN(num) || num <= 0) return '请输入有效的正数';
      return null;
    },
    parse: (value) => parseFloat(value),
    apply: (draft, value) => { draft.stop_loss = value; },
    format: (value) => `${value}`,
    returnPanel: 'rule_wizard',
  },

  minint: {
    label: '最小动作间隔',
    prompt: '请输入同群两次下注的最小间隔秒数（0–3600，例如：0、3、5、10）',
    validate: (value) => {
      const num = parseInt(value, 10);
      if (isNaN(num) || String(num) !== value.trim()) return '请输入有效的整数';
      if (num < 0 || num > 3600) return '间隔需为 0–3600 秒';
      return null;
    },
    parse: (value) => parseInt(value, 10),
    apply: (draft, value) => { draft.min_interval = value; },
    format: (value) => `${value} 秒`,
    returnPanel: 'rule_wizard',
  },

  // ── 主面板：今日止盈目标（直接写库，不走规则草稿）──
  take_profit: {
    label: '今日止盈目标',
    prompt:
      '请输入本轮盈利达到多少就停止运行（正数，例如：500、1000、5000）\n' +
      '💡 输入 0 表示不启用止盈（永不自动停止）',
    validate: (value) => {
      const num = parseFloat(value);
      if (isNaN(num)) return '请输入有效的数字';
      if (num < 0) return '止盈目标不能为负数（输入 0 表示不启用）';
      if (num > 100000000) return '止盈目标过大';
      return null;
    },
    parse: (value) => parseFloat(value),
    // 直接写 accounts，不走 wizard_state 草稿
    directApply: (botUserId, value) => {
      const todayProfit = beijingTodayProfit(botUserId);
      // 0 → 视为「不启用」；同时把本轮盈利清零重新开始
      accountDao.setTakeProfit(botUserId, value > 0 ? value : null, todayProfit);
      accountDao.resumeFromProfitStop(botUserId, todayProfit);
      operationLogDao.insert({
        bot_user_id: botUserId,
        action: value > 0 ? 'SET_TAKE_PROFIT' : 'CLEAR_TAKE_PROFIT',
        detail: value > 0
          ? `设置今日止盈目标 ${value}（本轮盈利从 0 起算）`
          : '关闭今日止盈',
      });
      logger.info(`[INPUT_SCENE] 用户 ${botUserId} 止盈目标 = ${value > 0 ? value : '不启用'}`);
    },
    format: (value) => (value == null || value === '未设置' ? '未设置' : `${value}`),
    returnPanel: 'dashboard',
  },

  // ── 监听群：关键词搜索（更新 wizard_state.keyword）──
  chat_keyword: {
    label: '群名搜索',
    prompt: '请输入群名关键词（直接发送即搜索，发送 /clear 清空关键词）',
    validate: () => null,
    parse: (value) => value.trim(),
    apply: null, // 特殊处理
    format: (value) => value,
    returnPanel: 'chat_list',
  },
};

const inputScene = new Scenes.WizardScene(
  'input',

  // ── 步骤 0：显示输入提示（编辑当前消息） ──
  async (ctx) => {
    const field = ctx.scene.state?.field;
    const botUserId = String(ctx.from.id);

    if (!field || !FIELD_CONFIG[field]) {
      await ctx.reply('❌ 无效的输入字段');
      return ctx.scene.leave();
    }

    ctx.wizard.state.field = field;
    ctx.wizard.state.botUserId = botUserId;

    const config = FIELD_CONFIG[field];
    const currentValue = readCurrentValue(botUserId, field);

    let text = `🔢 <b>自定义${config.label}</b>\n`;
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += `当前值：${config.format ? config.format(currentValue) : currentValue}\n`;
    text += `${config.prompt}\n`;
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += '💡 请直接发送数值消息\n';
    text += '💡 发送 /cancel 取消';

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '❎ 取消', callback_data: cancelCallback(field) }]
          ]
        }
      });
    } catch (err) {
      await ctx.reply(text, { parse_mode: 'HTML' });
    }

    logger.info(`[INPUT_SCENE] 用户 ${botUserId} 开始自定义输入: ${field}`);

    return ctx.wizard.next();
  },

  // ── 步骤 1：接收用户输入 ──
  async (ctx) => {
    const botUserId = ctx.wizard.state.botUserId;
    const field = ctx.wizard.state.field;
    const input = ctx.message?.text?.trim();

    if (input === '/cancel') {
      await ctx.reply('❎ 已取消输入');
      logger.info(`[INPUT_SCENE] 用户 ${botUserId} 取消输入: ${field}`);
      return ctx.scene.leave();
    }

    if (!input) {
      await ctx.reply('❌ 请输入有效值');
      return;
    }

    const config = FIELD_CONFIG[field];

    if (field === 'chat_keyword' && input === '/clear') {
      applyKeyword(botUserId, '');
      await finish(ctx, botUserId, field, '');
      return ctx.scene.leave();
    }

    const validationError = config.validate(input);
    if (validationError) {
      await ctx.reply(`❌ ${validationError}\n请重新输入，或发送 /cancel 取消`);
      return;
    }

    const value = config.parse(input);

    try {
      if (config.directApply) {
        // 直接落库的字段（如主面板的止盈目标），不走向导草稿
        config.directApply(botUserId, value);
      } else if (field === 'chat_keyword') {
        applyKeyword(botUserId, value);
      } else {
        // 写入规则向导草稿（wizard_state.draft）
        const panelCtx = panelContextDao.get(botUserId);
        if (!panelCtx || !panelCtx.wizard_state) {
          await ctx.reply('❌ 向导已过期，请重新操作');
          return ctx.scene.leave();
        }
        const state = JSON.parse(panelCtx.wizard_state);
        if (state.scene !== 'rule_wizard' || !state.draft) {
          await ctx.reply('❌ 向导已过期，请重新点「新建规则」');
          return ctx.scene.leave();
        }
        config.apply(state.draft, value);
        panelContextDao.updateWizardState(botUserId, JSON.stringify(state));
      }

      logger.info(`[INPUT_SCENE] 用户 ${botUserId} 更新 ${field} = ${field === 'chat_keyword' ? value : config.format(value)}`);

      // 删除用户发送的数值消息（保持界面干净）
      try {
        await ctx.deleteMessage();
      } catch (_) {}

      // 渲染回原面板
      await finish(ctx, botUserId, field, value);

      return ctx.scene.leave();
    } catch (error) {
      logger.error(`[INPUT_SCENE] 用户 ${botUserId} 更新失败: ${error.message}`, error);
      await ctx.reply(`❌ 更新失败：${error.message}`);
      return ctx.scene.leave();
    }
  }
);

/**
 * 读取字段当前值（向导草稿 / 搜索关键词）
 */
function readCurrentValue(botUserId, field) {
  // 直写库的字段（如止盈目标）从 accounts 读当前值
  if (field === 'take_profit') {
    const account = accountDao.getActive(botUserId);
    return account && account.take_profit != null ? account.take_profit : '未设置';
  }

  const panelCtx = panelContextDao.get(botUserId);
  if (!panelCtx || !panelCtx.wizard_state) return '未设置';
  try {
    const state = JSON.parse(panelCtx.wizard_state);
    if (field === 'chat_keyword') return state.keyword || '（空）';
    if (state.scene === 'rule_wizard') {
      const keyMap = {
        streak: 'streak_count', base: 'base_bet', ratio: 'martingale_ratio',
        maxlose: 'max_lose_streak', stop: 'stop_loss', minint: 'min_interval',
      };
      const v = state.draft?.[keyMap[field]];
      return v ?? '未设置';
    }
  } catch (_) { /* 忽略 */ }
  return '未设置';
}

/**
 * 北京时间今日 00:00 起的已结算盈亏合计（止盈基准用）
 * @param {string} botUserId
 * @returns {number}
 */
function beijingTodayProfit(botUserId) {
  const shifted = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const midnight = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} 00:00:00`;
  return actionLogDao.sumProfit(botUserId, midnight);
}

/**
 * 搜索关键词写入 chat_select 状态
 */
function applyKeyword(botUserId, keyword) {
  const panelCtx = panelContextDao.get(botUserId);
  if (!panelCtx || !panelCtx.wizard_state) return;
  try {
    const state = JSON.parse(panelCtx.wizard_state);
    if (state.scene === 'chat_select') {
      state.keyword = keyword;
      state.page = 0;
      panelContextDao.updateWizardState(botUserId, JSON.stringify(state));
    }
  } catch (_) { /* 忽略 */ }
}

/**
 * 输入完成后渲染回原面板
 */
async function finish(ctx, botUserId, field, value) {
  const config = FIELD_CONFIG[field];
  const panelRenderer = ctx.services.panelRenderer;

  if (field === 'chat_keyword') {
    const ChatHandler = require('../handlers/chat.handler');
    const allChats = await ChatHandler.fetchGroups(botUserId, ctx.services);
    const panelCtx = panelContextDao.get(botUserId);
    let state = { selected: [], page: 0, keyword: value };
    try {
      const parsed = JSON.parse(panelCtx?.wizard_state || '{}');
      if (parsed.scene === 'chat_select') state = { ...parsed, keyword: value, page: 0 };
    } catch (_) { /* 忽略 */ }
    await panelRenderer.render(ctx, 'chat_list', {
      allChats,
      selected: state.selected,
      page: 0,
      keyword: value,
      savedCount: monitoredChatDao.countByUser(botUserId),
    });
    return;
  }

  // 直写库的字段（如止盈目标）→ 回主面板
  if (config.returnPanel === 'dashboard') {
    const DashboardHandler = require('../handlers/dashboard.handler');
    await panelRenderer.render(ctx, 'dashboard', DashboardHandler.collectData(botUserId));
    return;
  }

  await panelRenderer.render(ctx, config.returnPanel, {
    draft: readDraft(botUserId),
    monitoredChats: monitoredChatDao.listByUser(botUserId),
  });
}

function readDraft(botUserId) {
  const panelCtx = panelContextDao.get(botUserId);
  try {
    const state = JSON.parse(panelCtx?.wizard_state || '{}');
    if (state.scene === 'rule_wizard') return state.draft || {};
  } catch (_) { /* 忽略 */ }
  return {};
}

function cancelCallback(field) {
  if (field === 'chat_keyword') return 'chat:main';
  if (field === 'take_profit') return 'dashboard:refresh';
  return 'rule:w_back';
}

// 超时处理：2 分钟无操作自动退出
inputScene.use(async (ctx, next) => {
  const IDLE_TIMEOUT = 2 * 60 * 1000;
  if (!ctx.wizard.state.lastActivity) {
    ctx.wizard.state.lastActivity = Date.now();
  }

  const elapsed = Date.now() - ctx.wizard.state.lastActivity;
  if (elapsed > IDLE_TIMEOUT) {
    await ctx.reply('⏰ 输入已超时，请重新操作');
    return ctx.scene.leave();
  }

  ctx.wizard.state.lastActivity = Date.now();
  return next();
});

module.exports = inputScene;
