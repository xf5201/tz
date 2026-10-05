// src/services/strategy-executor.service.js
const accountDao = require('../db/account.dao');
const ruleDao = require('../db/rule.dao');
const ruleStateDao = require('../db/rule-state.dao');
const messageLogDao = require('../db/message-log.dao');
const actionLogDao = require('../db/action-log.dao');
const operationLogDao = require('../db/operation-log.dao');
const { transaction } = require('../db/connection');
const {
  evaluateStreak, calcAmount, calcCumulativeStake, buildBetText,
} = require('../core/rule.engine');
const { parseSettle } = require('../core/dice.parser');
const logger = require('../utils/logger');
const { maskChatId } = require('../utils/mask.util');

// 运行约束（与 pc28 同款运行时限制）：
//   RATE_LIMIT_PER_MIN  → 单群每分钟动作上限（滑动窗口）
const RATE_LIMIT_PER_MIN = 20;

// ═══════════════════════════════════════════
// 下注窗口识别词（直接写死，不做配置）：
//   群内开盘消息形如「期号: xxx 🧧底注: 1u 单骰子文字下注格式为: …」
//   归一化（去空白、全角冒号转半角、小写）后包含「底注:1u」即视为开盘。
// ═══════════════════════════════════════════
const BET_WINDOW_KEYWORD = '底注:1u';

/**
 * 判断消息是否为下注窗口开盘信号（识别到底注：1u）
 * @param {string|null} text - 消息文本
 * @returns {boolean}
 */
function isBetWindowMessage(text) {
  if (!text) return false;
  const normalized = String(text)
    .replace(/\s+/g, '')
    .replace(/：/g, ':')
    .toLowerCase();
  return normalized.includes(BET_WINDOW_KEYWORD);
}

/**
 * 策略执行器（动态监测 + 底注闸门 + 结算消息判输赢）
 *
 * 消息驱动，按「规则 × 群」独立状态流转：
 *   dice（开奖）      → 结算由结算消息负责；此处做触发判定，满足连击 → armed（待发）
 *   底注:1u（开盘）    → armed 的下注真正发送 → pending（已发待结算）
 *   期输赢（结算）     → 解析结算消息，用登录账号用户 ID 匹配输赢与盈亏，
 *                        更新连败/止损；结算后立即用该条开奖点数评估下一轮待发
 *
 * 状态流转：无 → armed(待发) → pending(已发待结算) → 无（或连败后重新 armed）
 * 模拟模式：DRY_RUN 只记录，按结算消息中的开奖点数判定输赢，不产生盈亏金额。
 */
class StrategyExecutorService {
  /**
   * @param {object} deps
   * @param {object} deps.betSender
   * @param {object} deps.notification
   */
  constructor(deps) {
    this.betSender = deps.betSender;
    this.notification = deps.notification;

    // 运行时限流状态（内存即可，重启清零）
    this._lastActionAt = new Map();  // "userId:chatId" → ts
    this._rateWindow = new Map();    // "userId:chatId" → number[] 时间戳窗口
  }

  /**
   * 开奖消息入口（骰子）：触发判定 → 待发
   */
  async handleOpen(botUserId, chatId, dice) {
    const account = accountDao.getActive(botUserId);
    if (!account || account.status !== 'ACTIVE') return;

    const rules = ruleDao.listEnabledByUser(botUserId);
    if (rules.length === 0) return;

    const armedRules = [];

    transaction(() => {
      for (const rule of rules) {
        const state = ruleStateDao.ensure(rule.id, chatId);
        // 待发 / 挂起期间不重复触发（挂起由结算消息处理）
        if (state.armed_direction || state.pending_direction) continue;

        const armed = this._tryArm(botUserId, rule, chatId, dice.value, armedRules);
        void armed;
      }
    });

    if (armedRules.length > 0 && this.notification) {
      await this.notification.pushToUser(botUserId).catch(() => {});
    }

    return armedRules.length;
  }

  /**
   * 开盘信号入口（识别到底注：1u）：把「待发」的下注真正发送出去
   */
  async handleRoundOpen(botUserId, chatId) {
    const account = accountDao.getActive(botUserId);
    if (!account || account.status !== 'ACTIVE') return;

    const rules = ruleDao.listEnabledByUser(botUserId);
    if (rules.length === 0) return;

    const createdActions = [];

    transaction(() => {
      for (const rule of rules) {
        const state = ruleStateDao.ensure(rule.id, chatId);

        // 只有「待发」状态才下注
        if (!state.armed_direction || state.pending_direction) continue;

        // 前置校验：最小间隔 / 频率上限
        if (!this._checkMinInterval(botUserId, chatId, rule.min_interval)) {
          logger.info(`[STRATEGY_EXEC] 规则=${rule.id} 距上次动作不足 ${rule.min_interval}s，跳过本轮`);
          continue;
        }
        if (!this._checkRateLimit(botUserId, chatId)) {
          logger.warn(`[STRATEGY_EXEC] 群 ${maskChatId(chatId)} 触发每分钟 ${RATE_LIMIT_PER_MIN} 次上限，跳过本轮`);
          continue;
        }

        const direction = state.armed_direction;
        const amount = calcAmount(rule.base_bet, rule.martingale_ratio, state.consecutive_losses);
        const actionText = buildBetText(direction, amount);
        const isDry = rule.dry_run === 1;

        const actionId = actionLogDao.insert({
          bot_user_id: botUserId,
          rule_id: rule.id,
          chat_id: chatId,
          direction,
          bet_amount: amount,
          action_text: actionText,
          status: isDry ? 'DRY_RUN' : 'CREATED',
        });

        if (isDry) {
          // 模拟：清掉待发，不进入结算流程，连败数不变
          ruleStateDao.updateState(rule.id, chatId, {
            armedDirection: null,
            pendingDirection: null,
          });
        } else {
          // 实发：进入挂起结算，等「期输赢」消息判输赢
          ruleStateDao.updateState(rule.id, chatId, {
            armedDirection: null,
            pendingDirection: direction,
          });
        }

        createdActions.push({
          id: actionId,
          chat_id: chatId,
          action_text: actionText,
          direction,
          bet_amount: amount,
          status: isDry ? 'DRY_RUN' : 'CREATED',
        });

        operationLogDao.insert({
          bot_user_id: botUserId,
          action: 'BET_CREATED',
          detail: `规则「${rule.name || rule.id}」@${maskChatId(chatId)} 开盘下注: ${actionText}${isDry ? '（模拟）' : ''}`,
        });
        logger.info(
          `[STRATEGY_EXEC] 下注创建: 用户=${botUserId}, 规则=${rule.id}, ` +
          `群=${maskChatId(chatId)}, 动作=${actionText}${isDry ? ' (DRY_RUN)' : ''}`
        );
      }
    });

    // 实发（事务外异步执行，不阻塞其他用户消息处理）
    for (const action of createdActions) {
      if (action.status === 'DRY_RUN') continue;
      try {
        await this.betSender.sendBetMessage(botUserId, action);
      } catch (err) {
        logger.error(`[STRATEGY_EXEC] 发送下注失败: ${err.message}`);
      }
    }

    if (createdActions.length > 0 && this.notification) {
      await this.notification.pushToUser(botUserId).catch(() => {});
    }

    return createdActions.length;
  }

  /**
   * 结算消息入口（❤️第xxx期输赢）：
   * 解析开奖点数与本账号输赢（用户 ID 匹配），更新连败/止损，
   * 结算完成后立即用该条开奖点数评估是否进入下一轮「待发」。
   *
   * @param {string} botUserId
   * @param {string} chatId
   * @param {string} text - 结算消息文本
   */
  async handleSettleMessage(botUserId, chatId, text) {
    const account = accountDao.getActive(botUserId);
    if (!account || account.status !== 'ACTIVE') return;

    const rules = ruleDao.listEnabledByUser(botUserId);
    if (rules.length === 0) return;

    // botUserId 即登录账号的 TG 用户 ID（登录时强制同账号）
    const settle = parseSettle(text, botUserId);
    const pausedRules = [];
    const armedRules = [];
    let settledCount = 0;

    transaction(() => {
      for (const rule of rules) {
        const state = ruleStateDao.ensure(rule.id, chatId);

        // ── 实发注：按结算名单匹配本账号判定输赢 ──
        if (state.pending_direction) {
          const pending = actionLogDao.getLatestUnsettledSent(rule.id, chatId);
          if (!pending) continue;

          let isWin;
          let profit;
          if (settle.matched) {
            isWin = settle.isWin ? 1 : 0;
            if (settle.isWin) {
              profit = settle.profit != null ? settle.profit : null; // 赢：消息里的净盈利
            } else {
              profit = settle.profit != null ? settle.profit : -pending.bet_amount; // 输：亏本金
            }
          } else {
            // 结算名单没有本账号 → 输（输掉本金）
            isWin = 0;
            profit = -pending.bet_amount;
          }

          const changed = actionLogDao.markSettled(pending.id, isWin, profit);
          if (!changed) continue; // 已被并发结算

          const newLosses = isWin ? 0 : state.consecutive_losses + 1;
          ruleStateDao.updateState(rule.id, chatId, {
            consecutiveLosses: newLosses,
            pendingDirection: null,
          });
          settledCount++;

          logger.info(
            `[STRATEGY_EXEC] 结算: 规则=${rule.id}, 群=${maskChatId(chatId)}, ` +
            `方向=${state.pending_direction}, 点数=${settle.diceValue}, ` +
            `${isWin ? '赢' : '输'}${profit != null ? ` 盈亏=${profit}` : ''}, 连败=${newLosses}`
          );
          operationLogDao.insert({
            bot_user_id: botUserId,
            action: 'BET_SETTLED',
            detail: `规则「${rule.name || rule.id}」@${maskChatId(chatId)} ` +
              `${isWin ? '赢' : '输'}${profit != null ? ` ${profit}` : ''}，连败 ${newLosses}`,
          });

          // 止损硬约束：连败上限 / 累计投入止损
          if (newLosses >= rule.max_lose_streak) {
            ruleDao.update(rule.id, { enabled: 0 });
            pausedRules.push({ rule, chatId, reason: `连续未中 ${newLosses} 次，已达连败上限 ${rule.max_lose_streak}` });
            continue;
          }
          if (rule.stop_loss != null) {
            const stake = calcCumulativeStake(rule.base_bet, rule.martingale_ratio, newLosses);
            if (stake >= rule.stop_loss) {
              ruleDao.update(rule.id, { enabled: 0 });
              pausedRules.push({ rule, chatId, reason: `累计投入 ${stake} 已达止损上限 ${rule.stop_loss}` });
              continue;
            }
          }
        } else {
          // ── 模拟注：按结算消息中的开奖点数判定输赢（不产生盈亏金额） ──
          const dry = actionLogDao.getLatestUnsettledDry(rule.id, chatId);
          if (dry && settle.diceValue != null) {
            const win = settle.diceValue >= 4 ? 'BIG' : 'SMALL';
            const isWin = win === dry.direction ? 1 : 0;
            if (actionLogDao.markSettled(dry.id, isWin, null)) {
              settledCount++;
              logger.info(
                `[STRATEGY_EXEC] 模拟结算: 规则=${rule.id}, 方向=${dry.direction}, ` +
                `点数=${settle.diceValue}, ${isWin ? '赢' : '输'}`
              );
            }
          }
        }

        // ── 结算后立即用该条开奖点数评估下一轮「待发」（避免隔轮跳注） ──
        if (settle.diceValue != null && !state.armed_direction && !state.pending_direction) {
          this._tryArm(botUserId, rule, chatId, settle.diceValue, armedRules);
        }
      }
    });

    // 停用通知
    for (const { rule, chatId, reason } of pausedRules) {
      operationLogDao.insert({
        bot_user_id: botUserId,
        action: 'RULE_AUTO_PAUSED',
        detail: `规则「${rule.name || rule.id}」已自动停用：${reason}（群 ${maskChatId(chatId)}）`,
      });
      if (this.notification) {
        await this.notification.notifyEvent(
          botUserId,
          `🛑 规则「${rule.name || rule.id}」已自动停用：${reason}\n触发群：${maskChatId(chatId)}\n需人工确认后到「规则配置」重新启用。`
        );
      }
    }

    if ((settledCount > 0 || armedRules.length > 0) && this.notification) {
      await this.notification.pushToUser(botUserId).catch(() => {});
    }

    return settledCount;
  }

  /**
   * 触发判定：满足「连续 N 次开出大/小」→ 进入待发（反向下注）
   * 需在事务内调用
   */
  _tryArm(botUserId, rule, chatId, diceValue, armedRules) {
    const need = Math.max(2, rule.streak_count || 2);
    const recentValues = messageLogDao.recentValues(chatId, need + 1).slice(1);
    const direction = evaluateStreak(rule, diceValue, recentValues);
    if (!direction) return false;

    ruleStateDao.updateState(rule.id, chatId, { armedDirection: direction });
    armedRules.push({ rule, chatId, direction });

    operationLogDao.insert({
      bot_user_id: botUserId,
      action: 'RULE_ARMED',
      detail: `规则「${rule.name || rule.id}」@${maskChatId(chatId)} ` +
        `连击满足，待发「${direction === 'BIG' ? '大' : '小'}」，等待开盘信号`,
    });
    logger.info(
      `[STRATEGY_EXEC] 已待发: 用户=${botUserId}, 规则=${rule.id}, ` +
      `群=${maskChatId(chatId)}, 方向=${direction}（等待底注开盘信号）`
    );
    return true;
  }

  /**
   * 最小动作间隔校验（同群同用户）
   */
  _checkMinInterval(botUserId, chatId, minIntervalSec) {
    const interval = Math.max(0, Number(minIntervalSec) || 0) * 1000;
    if (interval <= 0) return true;

    const key = `${botUserId}:${chatId}`;
    const last = this._lastActionAt.get(key) || 0;
    const now = Date.now();
    if (now - last < interval) return false;

    this._lastActionAt.set(key, now);
    return true;
  }

  /**
   * 频率上限校验（单群滑动窗口）
   */
  _checkRateLimit(botUserId, chatId) {
    const key = `${botUserId}:${chatId}`;
    const now = Date.now();
    const window = (this._rateWindow.get(key) || []).filter((ts) => now - ts < 60_000);

    if (window.length >= RATE_LIMIT_PER_MIN) {
      this._rateWindow.set(key, window);
      return false;
    }

    window.push(now);
    this._rateWindow.set(key, window);
    return true;
  }

  /**
   * 规则增改/人工启用后重置全部群状态（新一轮开始）
   * @param {number} ruleId
   */
  resetRuleState(ruleId) {
    ruleStateDao.resetByRule(ruleId);
  }
}

module.exports = { StrategyExecutorService, isBetWindowMessage, BET_WINDOW_KEYWORD };
