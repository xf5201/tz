// src/bot/panels/panel.renderer.js
const logger = require('../../utils/logger');
const tgLimiter = require('../../utils/tg-rate-limiter');
/**
 * 面板渲染器（PanelRenderer）
 *
 * 单消息模式：所有面板共用一条消息，通过 editMessageText 原地切换；
 * 旧消息被删除 / 无法编辑时自动自愈（重新发送）。
 */
const PANEL_ALIAS = {
  chat_main:   { file: 'monitored-chat', subPanel: 'main' },
  chat_list:   { file: 'monitored-chat', subPanel: 'list' },
  chat_saved:  { file: 'monitored-chat', subPanel: 'saved' },
  rule_list:   { file: 'rule', subPanel: 'list' },
  rule_wizard: { file: 'rule', subPanel: 'wizard' },
  rule_streak: { file: 'rule', subPanel: 'streak' },
  rule_base:   { file: 'rule', subPanel: 'base' },
  rule_ratio:  { file: 'rule', subPanel: 'ratio' },
  rule_maxlose:{ file: 'rule', subPanel: 'maxlose' },
  rule_stop:   { file: 'rule', subPanel: 'stop' },
  rule_minint: { file: 'rule', subPanel: 'minint' },
  account_panel: { file: 'account' },
  login_panel:   { file: 'login' },
};

class PanelRenderer {
  constructor(bot, panelContextDao) {
    this.bot = bot;
    this.panelContextDao = panelContextDao;
  }

  _resolve(panelName, data) {
    const alias = PANEL_ALIAS[panelName];
    if (alias) {
      if (alias.subPanel && !data.subPanel) data.subPanel = alias.subPanel;
      return alias.file;
    }
    return panelName;
  }

  _normalizeMarkup(keyboard) {
    if (!keyboard) return undefined;
    if (keyboard.reply_markup) return keyboard.reply_markup;
    return keyboard;
  }

  /**
   * 渲染面板（用户主动触发）
   */
  async render(ctx, panelName, data = {}, options = {}) {
    const file = this._resolve(panelName, data);
    const PanelClass = require(`./${file}.panel.js`);
    const { text, keyboard } = await PanelClass.render(ctx, data);
    const reply_markup = this._normalizeMarkup(keyboard);

    const botUserId = String(ctx.from.id);
    const panelCtx = this.panelContextDao.get(botUserId);

    // 辅助函数：发送全新的面板消息并同步数据库记录
    const sendNewAndSave = async () => {
      // 发送也走限速队列（与事件通知、面板编辑同一聊天，串行+间隔）
      const msg = await tgLimiter.run(
        botUserId,
        () => ctx.reply(text, { parse_mode: 'HTML', reply_markup }),
        { label: `panel.new user=${botUserId} panel=${panelName}` }
      );
      this.panelContextDao.upsert(
        botUserId,
        msg.chat.id,
        msg.message_id,
        panelName
      );
      return msg;
    };

    // 如果显式要求 forceNew，或者当前没有旧面板上下文，直接发新消息
    if (options.forceNew || !panelCtx || !panelCtx.message_id) {
      await sendNewAndSave();
      logger.debug(`[PANEL] 用户 ${botUserId} 发送新面板: ${panelName}`);
      return;
    }

    try {
      // 加入发送队列：面板编辑与事件通知共走限速器，同聊天强制间隔，避免 429
      await tgLimiter.run(
        panelCtx.chat_id,
        () => this.bot.telegram.editMessageText(
          panelCtx.chat_id,
          panelCtx.message_id,
          null,
          text,
          { parse_mode: 'HTML', reply_markup }
        ),
        { label: `panel.render user=${botUserId} panel=${panelName}` }
      );
      // 更新当前面板名称
      this.panelContextDao.updatePanel(botUserId, panelName);
      logger.debug(`[PANEL] 用户 ${botUserId} 编辑更新面板: ${panelName}`);
    } catch (err) {
      const errDesc = err.description || err.message || '';

      // 内容未变化 → 忽略
      if (errDesc.includes('message is not modified')) {
        logger.debug(`[PANEL] 面板内容未变化，跳过编辑`);
        return;
      }

      // 消息被删除 / 无法找到旧消息 / query失效 → 自动自愈（重新发送）
      if (
        errDesc.includes('message to edit not found') ||
        errDesc.includes("message can't be edited") ||
        errDesc.includes('chat not found')
      ) {
        logger.warn(`[PANEL] 旧面板消息不存在，重新发送新面板`);
        await sendNewAndSave();
        return;
      }

      // 其他未预期的 API 错误，强行降级重新发送，确保界面能够展示
      // 但 429 限流例外：限速器已自动重试仍失败，说明当前出口很堵，
      // 再降级加发新消息只会火上浇油——放弃本次渲染，等下次状态变化再更
      if (/Too Many Requests|429|retry after/i.test(errDesc)) {
        logger.warn(`[PANEL] 编辑面板遇限流（重试未成），本次放弃，避免加剧限流: ${errDesc}`);
        return;
      }
      logger.error(`[PANEL] 编辑面板失败 (${errDesc})，降级发送新消息`);
      await sendNewAndSave();
    }
  }

  /**
   * 推送更新（系统主动触发）
   */
  async pushUpdate(botUserId, panelName, data = {}) {
    const panelCtx = this.panelContextDao.get(botUserId);
    if (!panelCtx || panelCtx.current_panel !== panelName) return;

    const file = this._resolve(panelName, data);
    const PanelClass = require(`./${file}.panel.js`);
    const { text, keyboard } = await PanelClass.render(
      { from: { id: botUserId } },
      data
    );
    const reply_markup = this._normalizeMarkup(keyboard);

    try {
      // 加入发送队列：推送编辑走限速器（同聊天 1条/秒 + 429 自动重试）
      await tgLimiter.run(
        panelCtx.chat_id,
        () => this.bot.telegram.editMessageText(
          panelCtx.chat_id,
          panelCtx.message_id,
          null,
          text,
          { parse_mode: 'HTML', reply_markup }
        ),
        { label: `panel.push user=${botUserId} panel=${panelName}` }
      );
      logger.debug(`[PANEL] 推送更新: 用户 ${botUserId} → ${panelName}`);
    } catch (err) {
      const errDesc = err.description || err.message || '';
      if (errDesc.includes('message is not modified')) return;

      if (errDesc.includes('message to edit not found')) {
        logger.warn(`[PANEL] 用户 ${botUserId} 面板消息已删除，推送自愈重发`);
        try {
          // 自愈重发也进队列（与事件通知同聊天串行，避免 429）
          const msg = await tgLimiter.run(
            botUserId,
            () => this.bot.telegram.sendMessage(botUserId, text, {
              parse_mode: 'HTML',
              reply_markup,
            }),
            { label: `panel.resend user=${botUserId}` }
          );
          this.panelContextDao.upsert(
            botUserId,
            msg.chat.id,
            msg.message_id,
            panelName
          );
        } catch (sendErr) {
          logger.warn(`[PANEL] 重发面板失败: ${sendErr.message}`);
        }
        return;
      }

      // 429 限流：稍等重试一次，否则这次状态变化就丢了（面板看起来"没更新"）
      const isFlood = /Too Many Requests|429|retry after/i.test(errDesc);
      if (isFlood) {
        const wait = Number((/retry after (\d+)/i.exec(errDesc) || [])[1] || 1) * 1000 + 300;
        await new Promise((r) => setTimeout(r, Math.min(wait, 5000)));
        try {
          await this.bot.telegram.editMessageText(
            panelCtx.chat_id, panelCtx.message_id, null, text,
            { parse_mode: 'HTML', reply_markup }
          );
          logger.debug(`[PANEL] 限流重试成功: 用户 ${botUserId} → ${panelName}`);
        } catch (retryErr) {
          logger.warn(`[PANEL] 限流重试仍失败: ${retryErr.message}`);
        }
        return;
      }

      logger.warn(`[PANEL] 推送更新失败: ${err.message}`);
    }
  }
}

module.exports = PanelRenderer;
