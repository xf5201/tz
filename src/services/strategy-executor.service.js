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

// 待发（armed）超时：连击满足后若长时间等不到「底注」开盘信号，说明窗口已过，
// 必须清掉 armed，否则 handleOpen 的 `if (state.armed_direction) continue`
// 会让该「规则 × 群」永久不再判定、不再下注。
const ARMED_TTL_MS = 3 * 60 * 1000;

// 挂起（pending）超时：下注后若长时间等不到结算消息（结算消息丢失 /
// 群消息改版），挂起会永久卡住该「规则 × 群」。巡检兜底超过该时长即解除并告警。
const PENDING_TTL_MS = 10 * 60 * 1000;

// 发送在途保护窗口（秒）：下注消息发送超时 30s + 两次退避重试（2s/8s）+ 重试发送
// 最长约 100s。窗口内存在 CREATED 动作说明发送还在进行，
// 此刻结算消息到达不能清挂起，否则发送完成后该注永远等不到结算（漏结算）。
const SEND_IN_FLIGHT_GUARD_SECONDS = 120;

// 连击中断后是否清零连败：连败只在「同一条倍投链」内有意义，
// 连击断了 = 这条链结束，新一轮应从基础金额重新开始。
const RESET_LOSSES_ON_CHAIN_BREAK = true;

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
 * 状态流转：无 → armed(待发) → pending(已发待结算) → 无（或连败后重新 armed）
 *
 * 修复要点（原实现的四个缺陷）：
 *   1. 结算后重新待发用了过期 state 快照 → 每轮都跳过一轮，倍投链被腰斩
 *   2. 发送结果未回写状态 → 发送失败时 pending 永久卡死，规则 × 群永久不动作
 *   3. armed 等不到开盘信号时无任何清理 → 同样永久卡死
 *   4. 最小间隔 / 限流的 key 不含 rule_id → 同群多规则时只有第一条规则能下注
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
    this._lastActionAt = new Map();  // "userId:chatId:ruleId" → ts
    this._rateWindow = new Map();    // "userId:chatId:ruleId" → number[] 时间戳窗口
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
        // 自愈：等不到开盘信号的 armed 必须清掉，否则规则 × 群永久不判定
        if (ruleStateDao.clearStaleArmed(rule.id, chatId, ARMED_TTL_MS)) {
          logger.warn(
            `[STRATEGY_EXEC] 规则=${rule.id} 群=${maskChatId(chatId)} 待发超时已清理（未等到开盘信号）`
          );
        }

        const state = ruleStateDao.ensure(rule.id, chatId);
        // 待发 / 挂起期间不重复触发（挂起由结算消息处理）
        if (state.armed_direction || state.pending_direction) continue;

        const armed = this._tryArm(botUserId, rule, chatId, dice.value, armedRules);

        // 连击中断 = 本条倍投链结束 → 新一轮从基础金额开始
        if (!armed && RESET_LOSSES_ON_CHAIN_BREAK && state.consecutive_losses > 0) {
          ruleStateDao.updateState(rule.id, chatId, { consecutiveLosses: 0 });
          logger.info(
            `[STRATEGY_EXEC] 连击中断，连败清零: 规则=${rule.id}, 群=${maskChatId(chatId)}`
          );
        }
      }
    });

    if (armedRules.length > 0 && this.notification) {
      await this.notification.pushToUser(botUserId).catch(() => {});
    }

    return armedRules.length;
  }

  /**
   * 开盘信号入口（识别到底注：1u）：把「待发」的下注真正发送出去
   *
   * 关键：只有「发送成功」才置 pending，失败则清掉 armed（本轮放弃），
   * 避免 pending 卡死导致该规则 × 群永久不再下注。
   */
  async handleRoundOpen(botUserId, chatId) {
    const account = accountDao.getActive(botUserId);
    if (!account || account.status !== 'ACTIVE') return;

    const rules = ruleDao.listEnabledByUser(botUserId);
    if (rules.length === 0) return;

    const candidates = [];

    transaction(() => {
      for (const rule of rules) {
        if (ruleStateDao.clearStaleArmed(rule.id, chatId, ARMED_TTL_MS)) {
          logger.warn(
            `[STRATEGY_EXEC] 规则=${rule.id} 群=${maskChatId(chatId)} 待发超时已清理（未等到开盘信号）`
          );
        }

        const state = ruleStateDao.ensure(rule.id, chatId);

        // 只有「待发」状态才下注
        if (!state.armed_direction || state.pending_direction) continue;

        // 前置校验：最小间隔 / 频率上限（按 rule 维度，避免同群多规则互相吞额度）
        if (!this._checkMinInterval(botUserId, chatId, rule.id, rule.min_interval)) {
          logger.info(`[STRATEGY_EXEC] 规则=${rule.id} 距上次动作不足 ${rule.min_interval}s，跳过本轮`);
          continue;
        }
        if (!this._checkRateLimit(botUserId, chatId, rule.id)) {
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

        // 立即占位（事务内）：清 armed、置 pending。
        // 必须在这里占位，不能等发送成功再置 —— 否则发送耗时期间（最长 30s）
        // 若同一条开盘消息被 NewMessage 与轮询兜底重复投递，会再建一条下注＝重复下注。
        // 发送失败时再在下方回滚 pending（本轮放弃），不会卡死。
        ruleStateDao.updateState(rule.id, chatId, {
          armedDirection: null,
          pendingDirection: isDry ? null : direction,
        });

        candidates.push({ rule, direction, amount, actionId, actionText, isDry });
      }
    });

    // 事务外逐个发送，按发送结果回写状态
    for (const c of candidates) {
      if (c.isDry) {
        // 模拟：占位时未置 pending，这里无需回滚，连败数不变
        operationLogDao.insert({
          bot_user_id: botUserId,
          action: 'BET_CREATED',
          detail: `规则「${c.rule.name || c.rule.id}」@${maskChatId(chatId)} 开盘下注: ${c.actionText}（模拟）`,
        });
        continue;
      }

      let ok = false;
      try {
        ok = await this.betSender.sendBetMessage(botUserId, {
          id: c.actionId,
          chat_id: chatId,
          action_text: c.actionText,
        });
      } catch (err) {
        logger.error(`[STRATEGY_EXEC] 发送下注失败: ${err.message}`);
      }

      if (ok) {
        operationLogDao.insert({
          bot_user_id: botUserId,
          action: 'BET_CREATED',
          detail: `规则「${c.rule.name || c.rule.id}」@${maskChatId(chatId)} 开盘下注: ${c.actionText}`,
        });
        logger.info(
          `[STRATEGY_EXEC] 下注已发: 用户=${botUserId}, 规则=${c.rule.id}, ` +
          `群=${maskChatId(chatId)}, 动作=${c.actionText}`
        );
      } else {
        // 发送失败：回滚占位（pending → null），本轮放弃，等下一次连击重新触发
        transaction(() => ruleStateDao.updateState(c.rule.id, chatId, {
          armedDirection: null,
          pendingDirection: null,
        }));
        operationLogDao.insert({
          bot_user_id: botUserId,
          action: 'BET_FAILED',
          detail: `规则「${c.rule.name || c.rule.id}」@${maskChatId(chatId)} 下注发送失败，本轮放弃: ${c.actionText}`,
        });
        if (this.notification) {
          await this.notification.notifyEvent(
            botUserId,
            `⚠️ 规则「${c.rule.name || c.rule.id}」本轮下注「${c.actionText}」发送失败，已放弃该轮（未进入挂起）。`
          ).catch(() => {});
        }
      }
    }

    if (candidates.length > 0 && this.notification) {
      await this.notification.pushToUser(botUserId).catch(() => {});
    }

    return candidates.length;
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
        let state = ruleStateDao.ensure(rule.id, chatId);

        // ── 实发注：按结算名单匹配本账号判定输赢 ──
        if (state.pending_direction) {
          const pending = actionLogDao.getLatestUnsettledSent(rule.id, chatId);

          if (!pending) {
            // 异常自愈：挂起却没有可结算的已发记录（发送失败/记录错乱），
            // 必须清掉 pending，否则该规则 × 群永久不再下注。
            // 但发送在途保护窗口内（存在近期 CREATED 动作）不能清：
            // 此刻下注正在发送，清掉会让它发送完成后永远等不到结算。
            const inFlight = actionLogDao.getRecentCreated(rule.id, chatId, SEND_IN_FLIGHT_GUARD_SECONDS);
            if (inFlight) {
              logger.info(
                `[STRATEGY_EXEC] 结算消息到达但下注仍在发送中，跳过本次结算与清理: ` +
                `规则=${rule.id}, 群=${maskChatId(chatId)}, 动作=${inFlight.action_text}`
              );
            } else {
              ruleStateDao.updateState(rule.id, chatId, { pendingDirection: null });
              logger.warn(
                `[STRATEGY_EXEC] 挂起状态无对应已发记录，已自愈清除: 规则=${rule.id}, 群=${maskChatId(chatId)}`
              );
            }
          } else {
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
            if (changed) {
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

              // 止损硬约束：连败上限
              if (newLosses >= rule.max_lose_streak) {
                ruleDao.update(rule.id, { enabled: 0 });
                pausedRules.push({ rule, chatId, reason: `连续未中 ${newLosses} 次，已达连败上限 ${rule.max_lose_streak}` });
                continue;
              }
              // 止损硬约束：累计投入（只算「已经真实投出去的钱」，不再多算下一注）
              if (rule.stop_loss != null) {
                const spent = calcCumulativeStake(
                  rule.base_bet, rule.martingale_ratio, Math.max(0, newLosses - 1)
                );
                if (spent >= rule.stop_loss) {
                  ruleDao.update(rule.id, { enabled: 0 });
                  pausedRules.push({ rule, chatId, reason: `累计投入 ${spent} 已达止损上限 ${rule.stop_loss}` });
                  continue;
                }
              }
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

        // ── 结算后立即用该条开奖点数评估下一轮「待发」──
        // 关键修复：必须重新读一次状态，原代码用的是函数开头拿到的过期快照
        // （state.pending_direction 仍是旧值），导致这里永远进不来，
        // 结果「每次结算后都要空过一轮」，倍投链直接被腰斩。
        state = ruleStateDao.ensure(rule.id, chatId);
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
   * 挂起超时巡检（兜底，由定时器周期调用）
   *
   * 结算消息一旦丢失（轮询窗口跳过 / 群方改版消息格式），挂起会永久停留，
   * 该「规则 × 群」不再判定、不再下注 —— 静默卡死。超过 PENDING_TTL_MS
   * 仍未结算的挂起在此解除并告警，让倍投链恢复运转。
   *
   * 注意：解除时不猜测输赢，对应动作记录保留未结算状态，由人工对账。
   *
   * @returns {number} 解除的挂起数
   */
  async sweepStalePending() {
    const stale = ruleStateDao.listStalePending(Math.round(PENDING_TTL_MS / 1000));
    if (stale.length === 0) return 0;

    const ttlMin = Math.round(PENDING_TTL_MS / 60000);
    for (const row of stale) {
      transaction(() => ruleStateDao.updateState(row.rule_id, row.chat_id, { pendingDirection: null }));
      logger.warn(
        `[STRATEGY_EXEC] 挂起超时已解除: 规则=${row.rule_id}, 群=${maskChatId(row.chat_id)}` +
        `（超过 ${ttlMin} 分钟未等到结算消息）`
      );
      operationLogDao.insert({
        bot_user_id: row.bot_user_id,
        action: 'BET_SETTLE_TIMEOUT',
        detail: `规则「${row.rule_name || row.rule_id}」@${maskChatId(row.chat_id)} ` +
          `挂起下注「${row.pending_direction === 'BIG' ? '大' : '小'}」超过 ${ttlMin} 分钟未等到结算消息，已解除挂起`,
      });
      if (this.notification) {
        await this.notification.notifyEvent(
          row.bot_user_id,
          `⏱ 规则「${row.rule_name || row.rule_id}」@${maskChatId(row.chat_id)} 的挂起下注超过 ` +
            `${ttlMin} 分钟未等到结算消息，已解除挂起恢复运转。该笔输赢未记录，请人工核对。`
        ).catch(() => {});
      }
    }

    if (this.notification) {
      for (const userId of [...new Set(stale.map((r) => r.bot_user_id))]) {
        await this.notification.pushToUser(userId).catch(() => {});
      }
    }

    return stale.length;
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
   * 最小动作间隔校验（同群同规则）
   */
  _checkMinInterval(botUserId, chatId, ruleId, minIntervalSec) {
    const interval = Math.max(0, Number(minIntervalSec) || 0) * 1000;
    if (interval <= 0) return true;

    const key = `${botUserId}:${chatId}:${ruleId}`;
    const last = this._lastActionAt.get(key) || 0;
    const now = Date.now();
    if (now - last < interval) return false;

    this._lastActionAt.set(key, now);
    return true;
  }

  /**
   * 频率上限校验（同群同规则滑动窗口）
   */
  _checkRateLimit(botUserId, chatId, ruleId) {
    const key = `${botUserId}:${chatId}:${ruleId}`;
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
