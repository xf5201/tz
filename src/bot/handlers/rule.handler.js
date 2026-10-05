// src/bot/handlers/rule.handler.js
const ruleDao = require('../../db/rule.dao');
const ruleStateDao = require('../../db/rule-state.dao');
const operationLogDao = require('../../db/operation-log.dao');
const logger = require('../../utils/logger');

/**
 * 规则配置回调处理（动态监测模型，全按钮向导）
 *
 * 规则 = 连续 N 次开出大/小 → 自动反向下注，作用于全部已勾选监听群。
 * 无需选群、无需选触发属性、无需选下注方向。
 *
 * 支持回调：
 *   rule:list / rule:new / rule:edit:{id}
 *   rule:w_streak / rule:w_streak_count:{n} / rule:w_streak_custom
 *   rule:w_base[:{v}|custom] / rule:w_ratio[:{v}|custom]
 *   rule:w_maxlose[:{n}|custom] / rule:w_stop[:{v}|custom|none] / rule:w_minint[:{v}]
 *   rule:w_back / rule:w_confirm / rule:w_cancel
 *   rule:toggle:{id} / rule:w_dry（模拟切换）/ rule:del:{id} / rule:del_do:{id}
 */
class RuleHandler {
  static async handle(ctx, action, params, { panelRenderer, services }) {
    const botUserId = String(ctx.from.id);

    switch (action) {
      case 'list':
        await this.handleList(ctx, botUserId, { panelRenderer });
        break;

      case 'new':
        await this.handleNew(ctx, botUserId, { panelRenderer });
        break;

      case 'edit':
        await this.handleEdit(ctx, botUserId, parseInt(params[0], 10), { panelRenderer });
        break;

      // ── 数值预设项 ──
      case 'w_streak':
        await this.renderSub(ctx, botUserId, 'streak', { panelRenderer });
        break;

      case 'w_streak_count':
        await this.handleNumeric(ctx, botUserId, params, 'streak', { panelRenderer });
        break;

      case 'w_streak_custom':
        await ctx.scene.enter('input', { field: 'streak' });
        break;

      case 'w_base':
        await this.handleNumeric(ctx, botUserId, params, 'base', { panelRenderer });
        break;
      case 'w_ratio':
        await this.handleNumeric(ctx, botUserId, params, 'ratio', { panelRenderer });
        break;
      case 'w_maxlose':
        await this.handleNumeric(ctx, botUserId, params, 'maxlose', { panelRenderer });
        break;
      case 'w_stop':
        await this.handleNumeric(ctx, botUserId, params, 'stop', { panelRenderer });
        break;
      case 'w_stop_none':
        await this.withDraft(ctx, botUserId, (draft) => { draft.stop_loss = null; }, { panelRenderer });
        break;
      case 'w_minint':
        await this.handleNumeric(ctx, botUserId, params, 'minint', { panelRenderer });
        break;

      case 'w_dry':
        await this.withDraft(ctx, botUserId, (draft) => { draft.dry_run = draft.dry_run ? 0 : 1; }, { panelRenderer });
        break;

      // ── 向导导航 ──
      case 'w_back':
        await this.renderSub(ctx, botUserId, 'wizard', { panelRenderer });
        break;

      case 'w_confirm':
        await this.handleConfirm(ctx, botUserId, { panelRenderer, services });
        break;

      case 'w_cancel':
        ctx.services.panelContextDao.clearWizardState(botUserId);
        await this.handleList(ctx, botUserId, { panelRenderer });
        break;

      // ── 规则操作 ──
      case 'toggle':
        await this.handleToggle(ctx, botUserId, parseInt(params[0], 10), { panelRenderer });
        break;

      case 'del':
        await this.handleDeleteConfirm(ctx, botUserId, parseInt(params[0], 10), { panelRenderer });
        break;

      case 'del_do':
        await this.handleDelete(ctx, botUserId, parseInt(params[0], 10), { panelRenderer, services });
        break;

      default:
        logger.warn(`[RULE] 未知操作: ${action}`);
    }
  }

  // ═══════════════════════════════════════════
  // 列表 / 新建 / 编辑
  // ═══════════════════════════════════════════

  static async handleList(ctx, botUserId, { panelRenderer }) {
    const rules = ruleDao.listByUser(botUserId);
    const stateByRule = {};
    for (const s of ruleStateDao.listByUser(botUserId)) {
      (stateByRule[s.rule_id] = stateByRule[s.rule_id] || []).push(s);
    }
    await panelRenderer.render(ctx, 'rule_list', { rules, stateByRule });
  }

  static async handleNew(ctx, botUserId, { panelRenderer }) {
    // 新规则默认开启模拟模式（只记录不发送），确认策略有效后再手动切换实发
    const draft = { dry_run: 1 };
    ctx.services.panelContextDao.updateWizardState(botUserId, JSON.stringify({
      scene: 'rule_wizard', draft,
    }));
    await panelRenderer.render(ctx, 'rule_wizard', { draft });
  }

  static async handleEdit(ctx, botUserId, ruleId, { panelRenderer }) {
    const rule = ruleDao.getById(ruleId);
    if (!rule || rule.bot_user_id !== botUserId) throw new Error('规则不存在');

    const draft = {
      editId: rule.id,
      streak_count: rule.streak_count,
      base_bet: rule.base_bet,
      martingale_ratio: rule.martingale_ratio,
      max_lose_streak: rule.max_lose_streak,
      stop_loss: rule.stop_loss,
      min_interval: rule.min_interval,
      dry_run: rule.dry_run === 1,
      enabled: rule.enabled === 1,
    };

    ctx.services.panelContextDao.updateWizardState(botUserId, JSON.stringify({
      scene: 'rule_wizard', draft,
    }));
    await panelRenderer.render(ctx, 'rule_wizard', { draft });
  }

  // ═══════════════════════════════════════════
  // 向导通用
  // ═══════════════════════════════════════════

  static _loadDraft(ctx, botUserId) {
    const panelCtx = ctx.panelContext;
    if (panelCtx && panelCtx.wizard_state) {
      try {
        const state = JSON.parse(panelCtx.wizard_state);
        if (state.scene === 'rule_wizard') return state;
      } catch (_) { /* 忽略 */ }
    }
    throw new Error('向导已过期，请重新点「新建规则」');
  }

  /**
   * 修改草稿后重新渲染向导主界面
   */
  static async withDraft(ctx, botUserId, mutator, { panelRenderer, subPanel = 'wizard' }) {
    const state = this._loadDraft(ctx, botUserId);
    mutator(state.draft);
    ctx.services.panelContextDao.updateWizardState(botUserId, JSON.stringify(state));

    if (subPanel === 'wizard') {
      await panelRenderer.render(ctx, 'rule_wizard', { draft: state.draft });
    } else {
      await panelRenderer.render(ctx, `rule_${subPanel}`, { draft: state.draft });
    }
  }

  static async renderSub(ctx, botUserId, subPanel, { panelRenderer }) {
    const state = this._loadDraft(ctx, botUserId);
    await panelRenderer.render(ctx, `rule_${subPanel}`, { draft: state.draft });
  }

  /**
   * 数值预设项统一处理：
   *   无参数 → 渲染预设子面板；有参数 → 写入草稿；
   *   custom → 进入 input scene 自定义输入
   */
  static async handleNumeric(ctx, botUserId, params, kind, { panelRenderer }) {
    const value = params[0];

    if (value === undefined) {
      await this.renderSub(ctx, botUserId, kind, { panelRenderer });
      return;
    }

    if (value === 'custom') {
      await ctx.scene.enter('input', { field: kind });
      return;
    }

    await this.withDraft(ctx, botUserId, (draft) => {
      switch (kind) {
        case 'streak': {
          const n = parseInt(value, 10);
          if (!(n >= 2 && n <= 50)) throw new Error('连续次数需为 2–50');
          draft.streak_count = n;
          break;
        }
        case 'base': {
          const n = parseInt(value, 10);
          if (!(n >= 1 && n <= 100000)) throw new Error('金额需为 1–100000 的整数');
          draft.base_bet = n;
          break;
        }
        case 'ratio': {
          const n = parseFloat(value);
          if (!(n >= 1.0 && n <= 10.0)) throw new Error('倍投比例需为 1.0–10.0');
          draft.martingale_ratio = n;
          break;
        }
        case 'maxlose': {
          const n = parseInt(value, 10);
          if (!(n >= 1 && n <= 50)) throw new Error('连败上限需为 1–50');
          draft.max_lose_streak = n;
          break;
        }
        case 'stop': {
          const n = parseFloat(value);
          if (!(n > 0)) throw new Error('止损上限需为正数');
          draft.stop_loss = n;
          break;
        }
        case 'minint': {
          const n = parseInt(value, 10);
          if (!(n >= 0 && n <= 3600)) throw new Error('最小间隔需为 0–3600 秒');
          draft.min_interval = n;
          break;
        }
      }
    }, { panelRenderer });
  }

  // ═══════════════════════════════════════════
  // 保存 / 启停 / 删除
  // ═══════════════════════════════════════════

  static async handleConfirm(ctx, botUserId, { panelRenderer, services }) {
    const state = this._loadDraft(ctx, botUserId);
    const draft = state.draft;

    // 校验必填项
    const missing = [];
    if (!draft.streak_count) missing.push('连续次数');
    if (!draft.base_bet) missing.push('基础金额');
    if (missing.length > 0) {
      throw new Error(`尚有未完成项：${missing.join('、')}`);
    }

    const fields = {
      name: `连${draft.streak_count}把反买`,
      streak_count: draft.streak_count,
      base_bet: draft.base_bet,
      martingale_ratio: draft.martingale_ratio ?? 2.0,
      max_lose_streak: draft.max_lose_streak ?? 6,
      stop_loss: draft.stop_loss ?? null,
      min_interval: draft.min_interval ?? 3,
      dry_run: draft.dry_run ? 1 : 0,
    };

    let ruleId;
    if (draft.editId != null) {
      ruleDao.update(draft.editId, fields);
      ruleId = draft.editId;
    } else {
      ruleId = ruleDao.insert({ bot_user_id: botUserId, ...fields, enabled: 1 });
    }

    // 配置变更后全部群状态重置（新一轮开始）
    services.strategyExecutor.resetRuleState(ruleId);

    operationLogDao.insert({
      bot_user_id: botUserId,
      action: draft.editId != null ? 'UPDATE_RULE' : 'CREATE_RULE',
      detail: `${fields.name}｜基础${fields.base_bet}×${fields.martingale_ratio}｜连败上限${fields.max_lose_streak}${fields.stop_loss != null ? `｜止损${fields.stop_loss}` : ''}｜${fields.dry_run ? '🧪模拟' : '📤实发'}`,
    });

    ctx.services.panelContextDao.clearWizardState(botUserId);
    logger.info(`[RULE] 用户 ${botUserId} 保存规则 ${ruleId}: ${fields.name}`);
    await this.handleList(ctx, botUserId, { panelRenderer });
  }

  static async handleToggle(ctx, botUserId, ruleId, { panelRenderer }) {
    const rule = ruleDao.getById(ruleId);
    if (!rule || rule.bot_user_id !== botUserId) throw new Error('规则不存在');

    const enabled = rule.enabled ? 0 : 1;
    ruleDao.update(ruleId, { enabled });
    // 启用时重置全部群状态（人工确认恢复，重新开始计连败）
    if (enabled) ctx.services.strategyExecutor.resetRuleState(ruleId);

    operationLogDao.insert({
      bot_user_id: botUserId,
      action: enabled ? 'ENABLE_RULE' : 'DISABLE_RULE',
      detail: `规则「${rule.name || rule.id}」`,
    });

    // 同步向导草稿（若处于编辑态）
    this._syncDraftToggle(ctx, botUserId, ruleId, { enabled: enabled === 1 });
    await this.renderSub(ctx, botUserId, 'wizard', { panelRenderer });
  }

  static _syncDraftToggle(ctx, botUserId, ruleId, patch) {
    const panelCtx = ctx.panelContext;
    if (!panelCtx || !panelCtx.wizard_state) return;
    try {
      const state = JSON.parse(panelCtx.wizard_state);
      if (state.scene === 'rule_wizard' && state.draft?.editId === ruleId) {
        Object.assign(state.draft, patch);
        ctx.services.panelContextDao.updateWizardState(botUserId, JSON.stringify(state));
      }
    } catch (_) { /* 忽略 */ }
  }

  static async handleDeleteConfirm(ctx, botUserId, ruleId, { panelRenderer }) {
    const rule = ruleDao.getById(ruleId);
    if (!rule || rule.bot_user_id !== botUserId) throw new Error('规则不存在');

    await panelRenderer.render(ctx, 'confirm', {
      title: '删除规则',
      message: `确认删除规则「${rule.name || rule.id}」？\n该规则的历史动作记录将保留。`,
      confirmCallback: `rule:del_do:${ruleId}`,
      cancelCallback: `rule:edit:${ruleId}`,
    });
  }

  static async handleDelete(ctx, botUserId, ruleId, { panelRenderer, services }) {
    const rule = ruleDao.getById(ruleId);
    if (!rule || rule.bot_user_id !== botUserId) throw new Error('规则不存在');

    ruleDao.deleteById(ruleId);
    operationLogDao.insert({
      bot_user_id: botUserId,
      action: 'DELETE_RULE',
      detail: `规则「${rule.name || rule.id}」`,
    });

    ctx.services.panelContextDao.clearWizardState(botUserId);
    logger.info(`[RULE] 用户 ${botUserId} 删除规则 ${ruleId}`);
    await this.handleList(ctx, botUserId, { panelRenderer });
  }
}

module.exports = RuleHandler;
