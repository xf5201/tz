// src/services/strategy-executor.service.js
const accountDao = require('../db/account.dao');
const ruleDao = require('../db/rule.dao');
const ruleStateDao = require('../db/rule-state.dao');
const messageLogDao = require('../db/message-log.dao');
const actionLogDao = require('../db/action-log.dao');
const operationLogDao = require('../db/operation-log.dao');
const { transaction } = require('../db/connection');
const {
  evaluateStreak, calcAmount, calcCumulativeStake, buildBetText, isBalanceInsufficient,
} = require('../core/rule.engine');
const { parseSettle } = require('../core/dice.parser');
const {
  calcRoundProfit, isTakeProfitReached, isBaselineStale, beijingDate,
} = require('../core/profit.guard');
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

    // 今日已达标止盈 → 停止运行，等用户手动恢复
    if (account.profit_stopped === 1) return;

    const rules = ruleDao.listEnabledByUser(botUserId);
    if (rules.length === 0) return;

    // 余额见底 → 不再进入待发（省得待发后又因余额不足被拒）
    if (this.isBalanceDepleted(account, rules)) return;

    const armedRules = [];
    const resumedChats = [];

    transaction(() => {
      for (const rule of rules) {
        // 自愈：等不到开盘信号的 armed 必须清掉，否则规则 × 群永久不判定
        if (ruleStateDao.clearStaleArmed(rule.id, chatId, ARMED_TTL_MS)) {
          logger.warn(
            `[STRATEGY_EXEC] 规则=${rule.id} 群=${maskChatId(chatId)} 待发超时已清理（未等到开盘信号）`
          );
        }

        const state = ruleStateDao.ensure(rule.id, chatId);

        // 本群已单独停注：不下注，只观察连击是否重新满足（满足则自动恢复）
        if (state.blocked) {
          const resumed = this._evalBlockedResume(
            botUserId, rule, chatId, dice.value, state, armedRules
          );
          if (resumed) resumedChats.push(resumed);
          continue;
        }

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

    // 停注群自动恢复通知
    for (const chat of resumedChats) {
      if (this.notification) {
        await this.notification.notifyEvent(
          botUserId,
          `▶️ 规则「${chat.rule.name || chat.rule.id}」@${maskChatId(chat.chatId)} ` +
            `连击重新满足，已自动恢复下注（连败已清零）。`
        ).catch(() => {});
      }
    }

    if ((armedRules.length > 0 || resumedChats.length > 0) && this.notification) {
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

    // 今日已达标止盈 → 不再下注，等用户手动恢复
    if (account.profit_stopped === 1) return;

    const rules = ruleDao.listEnabledByUser(botUserId);
    if (rules.length === 0) return;

    // 余额见底 → 全局停注（不再下任何一注）
    if (this.isBalanceDepleted(account, rules)) {
      logger.info(
        `[STRATEGY_EXEC] 余额 ${account.balance} 不足，全局停注跳过本轮: 群=${maskChatId(chatId)}`
      );
      return;
    }

    const candidates = [];

    transaction(() => {
      for (const rule of rules) {
        if (ruleStateDao.clearStaleArmed(rule.id, chatId, ARMED_TTL_MS)) {
          logger.warn(
            `[STRATEGY_EXEC] 规则=${rule.id} 群=${maskChatId(chatId)} 待发超时已清理（未等到开盘信号）`
          );
        }

        const state = ruleStateDao.ensure(rule.id, chatId);

        // 本群已单独停注（连败/止损达上限）→ 不下注，等连击重新满足自动恢复
        if (state.blocked) continue;

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
    const blockedChats = [];
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
              // 只停「这个群」—— 规则本身继续在别的群运行，
              // 本群等连击中断后下一次触发自动恢复（连败清零）
              if (newLosses >= rule.max_lose_streak) {
                const reason = `连续未中 ${newLosses} 次，已达连败上限 ${rule.max_lose_streak}`;
                ruleStateDao.blockChat(rule.id, chatId, reason);
                blockedChats.push({ rule, chatId, reason });
                continue;
              }
              // 止损硬约束：累计投入（只算「已经真实投出去的钱」，不再多算下一注）
              if (rule.stop_loss != null) {
                const spent = calcCumulativeStake(
                  rule.base_bet, rule.martingale_ratio, Math.max(0, newLosses - 1)
                );
                if (spent >= rule.stop_loss) {
                  const reason = `累计投入 ${spent} 已达止损上限 ${rule.stop_loss}`;
                  ruleStateDao.blockChat(rule.id, chatId, reason);
                  blockedChats.push({ rule, chatId, reason });
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
        // 已停注的群：结算完就好，不再进入下一轮待发
        if (state.blocked) continue;
        // 已止盈停止 / 余额不足：本笔结算照常完成，但不再进入下一轮待发
        if (account.profit_stopped === 1 || this.isBalanceDepleted(account, rules)) continue;
        if (settle.diceValue != null && !state.armed_direction && !state.pending_direction) {
          this._tryArm(botUserId, rule, chatId, settle.diceValue, armedRules);
        }
      }
    });

    // 单群停注通知（规则仍在别的群继续运行）
    for (const { rule, chatId, reason } of blockedChats) {
      operationLogDao.insert({
        bot_user_id: botUserId,
        action: 'CHAT_AUTO_BLOCKED',
        detail: `规则「${rule.name || rule.id}」@${maskChatId(chatId)} 已停注：${reason}`,
      });
      logger.warn(
        `[STRATEGY_EXEC] 群停注: 规则=${rule.id}, 群=${maskChatId(chatId)}, 原因=${reason}`
      );
      if (this.notification) {
        await this.notification.notifyEvent(
          botUserId,
          `🛑 规则「${rule.name || rule.id}」已在本群停注：${reason}\n` +
          `群：${maskChatId(chatId)}\n` +
          `规则继续在其它群运行；本群等连击中断后重新触发即自动恢复（连败清零）。`
        ).catch(() => {});
      }
    }

    // 结算会让今日盈利变化 → 每次结算后检查是否达到止盈目标
    if (settledCount > 0) {
      await this.checkTakeProfit(botUserId).catch((err) => logger.error(
        `[STRATEGY_EXEC] checkTakeProfit 异常: 用户=${botUserId}, ${err.message}`
      ));
    }

    if ((settledCount > 0 || armedRules.length > 0 || blockedChats.length > 0) && this.notification) {
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
   * 停注群的恢复评估（开奖入口调用，需在事务内）
   *
   * 恢复条件（两步，缺一不可）：
   *   1. 停注之后出现了至少一次「连击中断」—— 否则连败刚达上限时
   *      连击往往还在延续，会立刻恢复，等于没停；
   *   2. 连击再次满足（连续 N 把同大小）—— 即用户说的「等下一次触发」。
   *
   * 恢复时连败清零，本轮立即按基础金额进入待发，不再沿用倍投金额。
   *
   * @returns {{rule: object, chatId: string}|null} 本次是否恢复
   */
  _evalBlockedResume(botUserId, rule, chatId, diceValue, state, armedRules) {
    const need = Math.max(2, rule.streak_count || 2);
    const recentValues = messageLogDao.recentValues(chatId, need + 1).slice(1);
    const direction = evaluateStreak(rule, diceValue, recentValues);

    if (!direction) {
      // 连击中断 → 记下标记，等下一次连击满足时再恢复
      if (!state.streak_broken) {
        ruleStateDao.updateState(rule.id, chatId, { streakBroken: 1 });
        logger.info(
          `[STRATEGY_EXEC] 停注群连击已中断，等待下次触发恢复: 规则=${rule.id}, 群=${maskChatId(chatId)}`
        );
      }
      return null;
    }

    if (!state.streak_broken) return null; // 同一条连击链还没断，继续停注

    // 连击重新满足 → 自动恢复本群（连败清零），并立即进入本轮待发
    ruleStateDao.unblockChat(rule.id, chatId);
    operationLogDao.insert({
      bot_user_id: botUserId,
      action: 'CHAT_AUTO_RESUMED',
      detail: `规则「${rule.name || rule.id}」@${maskChatId(chatId)} 连击重新满足，已自动恢复下注（连败清零）`,
    });
    logger.info(
      `[STRATEGY_EXEC] 停注群已自动恢复: 规则=${rule.id}, 群=${maskChatId(chatId)}`
    );
    this._tryArm(botUserId, rule, chatId, diceValue, armedRules);
    return { rule, chatId };
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

  /**
   * 余额是否低到必须全局停注（所有规则都不再下注）
   *
   * 判定见 core/rule.engine.isBalanceInsufficient：
   *   余额 <= BALANCE_FLOOR（默认 0），或连最便宜的一注都买不起 → 停注。
   * 从未解析到余额（null）时不停注，避免消息格式一变整套规则静默罢工。
   * 余额恢复（充值）后自动继续，无需人工重新启用规则。
   *
   * @param {object|null} account
   * @param {Array} rules - 启用中的规则
   * @returns {boolean}
   */
  isBalanceDepleted(account, rules = []) {
    if (!account) return false;
    return isBalanceInsufficient(account.balance, rules);
  }

  /**
   * 下注被机器人拒绝（余额不足 / 指令不合法等）
   *
   * 这笔注根本没投出去，因此：
   *   1. 动作记录标记 FAILED（不给输赢、不算连败）
   *   2. 必须立刻清掉挂起 —— 否则群里再来多少开奖都等不到这笔的结算，
   *      该「规则 × 群」永久卡死
   *   3. 通知用户（余额不足多半需要充值）
   *
   * @param {string} botUserId
   * @param {string} chatId
   * @param {object} bet - action_logs 行
   * @param {string|null} reason - 机器人给的失败原因
   */
  async handleBetRejected(botUserId, chatId, bet, reason) {
    const changed = actionLogDao.markRejected(bet.id, reason || '下注被机器人拒绝');

    // 清挂起：pending 正是这一笔才清（可能已被后续开奖结算，那时 changed=0 就不动）
    if (changed > 0 && bet.rule_id != null) {
      transaction(() => ruleStateDao.updateState(bet.rule_id, chatId, { pendingDirection: null }));
    }

    const detail = `下注「${bet.action_text}」被拒绝：${reason || '未知原因'}（未投出，不计连败）`;
    operationLogDao.insert({
      bot_user_id: botUserId,
      action: 'BET_REJECTED',
      detail: `${detail}｜群 ${maskChatId(chatId)}`,
    });
    logger.warn(`[STRATEGY_EXEC] 下注被拒: 用户=${botUserId}, 群=${maskChatId(chatId)}, ${detail}`);

    if (this.notification) {
      await this.notification.notifyEvent(
        botUserId,
        `⚠️ 群 ${maskChatId(chatId)} 下注「${bet.action_text}」被拒绝：${reason || '未知原因'}\n` +
        '该注未投出，不计入连败，挂起已解除。\n' +
        '常见原因是余额不足，请充值后自动恢复。'
      ).catch(() => {});
      await this.notification.pushToUser(botUserId).catch(() => {});
    }
  }

  /**
   * 余额更新后的告警检查（亏损过半 / 余额见底）
   *
   * 由消息分发器在写入余额后调用：
   *   - 亏损超过初始余额一半 → 告警（同一轮只告警一次，余额回升后重新武装）
   *   - 余额低于门槛 → 全局停注告警
   *
   * @param {string} botUserId
   * @returns {Promise<void>}
   */
  async checkBalanceAlerts(botUserId) {
    const account = accountDao.getActive(botUserId);
    if (!account || account.balance == null) return;

    const balance = Number(account.balance);

    // ① 亏损过半预警（需用户在面板开启）
    if (account.alert_enabled === 1 && account.initial_balance != null) {
      const initial = Number(account.initial_balance);
      const threshold = initial / 2;
      if (initial > 0 && balance < threshold) {
        if (!account.alert_notified_at) {
          const lost = initial - balance;
          const pct = ((lost / initial) * 100).toFixed(1);
          accountDao.markAlertNotified(botUserId);
          operationLogDao.insert({
            bot_user_id: botUserId,
            action: 'BALANCE_HALF_LOSS_ALERT',
            detail: `亏损已达初始余额一半：初始 ${initial} → 当前 ${balance}（亏 ${lost}，${pct}%）`,
          });
          logger.warn(`[STRATEGY_EXEC] 亏损过半告警: 用户=${botUserId}, ${initial} → ${balance}`);
          if (this.notification) {
            await this.notification.notifyEvent(
              botUserId,
              `📉 <b>亏损预警</b>\n` +
              `初始余额：${initial}\n当前余额：${balance}\n` +
              `已亏损：${lost}（${pct}%）\n` +
              `已跌破初始余额的一半，建议暂停策略并复核参数。`
            ).catch(() => {});
          }
        }
      } else if (account.alert_notified_at) {
        // 回到阈值以上 → 清除标记，下次回落可再次告警
        accountDao.clearAlertNotified(botUserId);
      }
    }

    // ② 余额见底 → 全局停注
    if (this.isBalanceDepleted(account, ruleDao.listEnabledByUser(botUserId))) {
      logger.warn(`[STRATEGY_EXEC] 余额已见底，全局停注: 用户=${botUserId}, 余额=${balance}`);
      if (this.notification) {
        await this.notification.notifyEvent(
          botUserId,
          `🛑 <b>余额不足，已全局停注</b>\n当前余额：${balance}\n` +
          '全部规则暂停下注，充值后自动恢复（无需重新启用规则）。'
        ).catch(() => {});
      }
    }
  }

  /**
   * 余额从「见底」恢复的通知（充值后自动继续，无需人工启用规则）
   *
   * @param {string} botUserId
   * @param {number} balance - 恢复后的余额
   */
  async notifyBalanceRestored(botUserId, balance) {
    operationLogDao.insert({
      bot_user_id: botUserId,
      action: 'BALANCE_RESTORED',
      detail: `余额已恢复至 ${balance}，全局停注解除，自动继续下注`,
    });
    logger.info(`[STRATEGY_EXEC] 余额已恢复: 用户=${botUserId}, 余额=${balance}`);

    if (this.notification) {
      await this.notification.notifyEvent(
        botUserId,
        `✅ <b>余额已恢复，自动继续</b>\n当前余额：${balance}\n` +
        '全局停注已解除，规则将在下一次连击触发时恢复下注。'
      ).catch(() => {});
      await this.notification.pushToUser(botUserId).catch(() => {});
    }
  }

  /**
   * 今日盈利（北京时间 00:00 起的已结算盈亏合计）
   * @param {string} botUserId
   * @returns {number}
   */
  getTodayProfit(botUserId) {
    const shifted = new Date(Date.now() + 8 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const midnight = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} 00:00:00`;
    return Math.round(actionLogDao.sumProfit(botUserId, midnight) * 100) / 100;
  }

  /**
   * 本轮盈利（用于止盈判定）= 今日总盈利 − 基准
   * @param {object} account
   * @returns {number}
   */
  getRoundProfit(account) {
    return calcRoundProfit(this.getTodayProfit(account.bot_user_id), account.profit_baseline);
  }

  /**
   * 止盈检查：本轮盈利达到目标 → 全局停止运行，等用户手动恢复
   *
   * 只在「盈利」达标时触发，亏钱永远不停。
   * 跨天自动重置基准与停止状态（新的一天重新开始）。
   *
   * @param {string} botUserId
   * @returns {Promise<boolean>} 本次是否触发了停止
   */
  async checkTakeProfit(botUserId) {
    const account = accountDao.getActive(botUserId);
    if (!account) return false;

    // 跨天 → 基准作废，本轮盈利重新从 0 起算，停止状态一并解除
    if (isBaselineStale(account.profit_baseline_date)) {
      accountDao.resetProfitBaseline(botUserId);
      logger.info(`[STRATEGY_EXEC] 新的一天，止盈基准已重置: 用户=${botUserId}`);
      return false;
    }

    if (account.profit_stopped === 1) return false; // 已停，等手动恢复
    if (account.take_profit == null) return false;  // 未启用止盈

    const roundProfit = this.getRoundProfit(account);
    if (!isTakeProfitReached(roundProfit, account.take_profit)) return false;

    accountDao.markProfitStopped(botUserId);
    // 待发不会被消费了，直接清掉（挂起保留：已投出去的注还要等结算）
    ruleStateDao.clearArmedByUser(botUserId);
    const todayProfit = this.getTodayProfit(botUserId);

    operationLogDao.insert({
      bot_user_id: botUserId,
      action: 'TAKE_PROFIT_STOPPED',
      detail: `本轮盈利 ${roundProfit} 已达止盈目标 ${account.take_profit}，停止运行（今日总盈利 ${todayProfit}）`,
    });
    logger.warn(
      `[STRATEGY_EXEC] 止盈停止: 用户=${botUserId}, 本轮盈利=${roundProfit}, ` +
      `目标=${account.take_profit}, 今日总盈利=${todayProfit}`
    );

    if (this.notification) {
      await this.notification.notifyEvent(
        botUserId,
        `🎯 <b>已达标止盈，停止运行</b>\n` +
        `本轮盈利：${roundProfit}（目标 ${account.take_profit}）\n` +
        `今日总盈利：${todayProfit}（保留，不受影响）\n\n` +
        `全部规则已停止下注。\n到主面板点「▶️ 恢复运行」才会继续（恢复后本轮盈利清零重新计算）。`
      ).catch(() => {});
      await this.notification.pushToUser(botUserId).catch(() => {});
    }
    return true;
  }

  /**
   * 恢复运行（用户手动触发）：解除止盈停止，本轮盈利清零重新计算
   *
   * 关键：清的是「本轮盈利」——做法是把基准拉到当前的今日总盈利。
   * 今日总盈利本身由一条条下注记录累计而来，完全不受影响。
   *
   * @param {string} botUserId
   * @returns {Promise<number>} 重置后的本轮盈利（应为 0）
   */
  async resumeFromTakeProfit(botUserId) {
    const todayProfit = this.getTodayProfit(botUserId);
    accountDao.resumeFromProfitStop(botUserId, todayProfit);

    operationLogDao.insert({
      bot_user_id: botUserId,
      action: 'TAKE_PROFIT_RESUMED',
      detail: `手动恢复运行，本轮盈利清零（基准设为今日总盈利 ${todayProfit}，今日总盈利不受影响）`,
    });
    logger.info(
      `[STRATEGY_EXEC] 止盈后手动恢复: 用户=${botUserId}, 基准=${todayProfit}`
    );
    return 0;
  }

  /**
   * 人工一键恢复：解除某用户全部停注群（连败清零）
   *
   * 正常情况下停注群会在「连击中断后再次触发」时自动恢复，
   * 这个方法用于不想再等、立刻全部恢复的场景。
   *
   * @param {string} botUserId
   * @returns {number} 恢复的群数
   */
  resumeBlockedChats(botUserId) {
    const n = ruleStateDao.unblockAllByUser(botUserId);
    if (n > 0) {
      operationLogDao.insert({
        bot_user_id: botUserId,
        action: 'CHAT_MANUAL_RESUMED',
        detail: `人工恢复 ${n} 个停注群（连败已清零）`,
      });
      logger.info(`[STRATEGY_EXEC] 用户 ${botUserId} 人工恢复停注群 ${n} 个`);
    }
    return n;
  }
}

module.exports = { StrategyExecutorService, isBetWindowMessage, BET_WINDOW_KEYWORD };
