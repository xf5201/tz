// src/services/strategy-executor.service.js
const accountDao = require('../db/account.dao');
const ruleDao = require('../db/rule.dao');
const ruleStateDao = require('../db/rule-state.dao');
const messageLogDao = require('../db/message-log.dao');
const actionLogDao = require('../db/action-log.dao');
const operationLogDao = require('../db/operation-log.dao');
const chatOddsDao = require('../db/chat-odds.dao');
const { transaction } = require('../db/connection');
const {
  evaluateStreak, calcAmount, calcCumulativeStake, buildBetText, isBalanceInsufficient, sizeOf,
} = require('../core/rule.engine');
const { parseSettle, parseWindowPeriod } = require('../core/dice.parser');
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

// 挂起（pending）超时：下注后若长时间等不到开奖点数（骰子消息丢失 /
// 群消息改版），挂起会永久卡住该「规则 × 群」。巡检兜底超过该时长即解除并告警。
const PENDING_TTL_MS = 10 * 60 * 1000;

// 发送在途保护窗口（秒）：下注消息发送超时 30s + 两次退避重试（2s/8s）+ 重试发送
// 最长约 100s。窗口内存在 CREATED 动作说明发送还在进行，
// 此刻开奖到达不能清挂起，否则发送完成后该注永远等不到结算（漏结算）。
const SEND_IN_FLIGHT_GUARD_SECONDS = 120;

// 连击中断后是否清零连败：连败只在「同一条倍投链」内有意义，
// 连击断了 = 这条链结束，新一轮应从基础金额重新开始。
const RESET_LOSSES_ON_CHAIN_BREAK = true;

// 默认赔率（大/小 1:0.95）：群内还没学到任何结算名单样本时用它估算赢单盈利，
// 学到样本后（chat_odds）按群动态赔率计算；名单里出现本账号时再修正为精确值。
const DEFAULT_PAYOUT_ODDS = 0.95;

// 每群在内存里保留的最近骰子条数（发送在途补结算 / 开盘兜底结算用）
const DICE_HISTORY_SIZE = 6;

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
 * 把 DB 里的北京时间字符串（'YYYY-MM-DD HH:mm:ss'）转为 epoch 毫秒
 * @param {string|null} beijingStr
 * @returns {number|null}
 */
function beijingTimeToMs(beijingStr) {
  if (!beijingStr) return null;
  const ms = Date.parse(String(beijingStr).replace(' ', 'T') + '+08:00');
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 策略执行器（动态监测 + 底注闸门 + 开奖点数直接判输赢）
 *
 * 状态流转：无 → armed(待发) → pending(已发待结算) → 无（或连败后重新 armed）
 *
 * 输赢判定模型（2026-10 改造）：
 *   - 开奖点数以机器人发出的骰子消息（MessageMediaDice）为准，
 *     大=4-6 / 小=1-3，与本方下注方向比对即得输赢，不再依赖
 *     「第xxx期输赢」名单里的用户 ID 匹配（名单丢失会错判，见 1525 案例）。
 *   - 赢单盈利 = 下注金额 × 群赔率（chat_odds，从各群历史结算名单动态学习，
 *     无样本用默认 0.95）；结算名单里恰好有本账号时修正为精确值。
 *   - 每笔下注记录所属期号（round_period），结算消息只处理同期的注单；
 *     骰子消息错过时，下一期开盘信号到达就用已捕获的骰子兜底结算。
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

    // 每群回合追踪（内存，重启后由下一条开盘消息/骰子重建）：
    //   _chatRounds  chatId → { period, atMs }   最近一次开盘信号的期号与到达时间
    //   _diceHistory chatId → [{ value, period, msgId, capturedAtMs }] 最近的骰子（新→旧）
    this._chatRounds = new Map();
    this._diceHistory = new Map();
  }

  /**
   * 开奖消息入口（骰子）：结算挂起注单 → 触发判定 → 待发
   *
   * 骰子消息就是开奖本身：挂起中的实发注在这里直接用点数判定输赢，
   * 不再等「第xxx期输赢」结算名单（名单丢失/改版不再影响输赢判定）。
   */
  async handleOpen(botUserId, chatId, dice) {
    const account = accountDao.getActive(botUserId);
    if (!account || account.status !== 'ACTIVE') return;

    const rules = ruleDao.listEnabledByUser(botUserId);
    if (rules.length === 0) return;

    // 记录本群最新骰子：发送在途的注单确认后要靠它补结算，
    // 开盘信号到达时的兜底结算也要用它
    const diceEntry = this._rememberDice(chatId, dice);

    // 止盈停止 / 余额见底：已投出去的注仍要正常结算，
    // 只是不再触发新一轮待发（arm / 停注群恢复评估）
    const canArm = account.profit_stopped !== 1 && !this.isBalanceDepleted(account, rules);

    const armedRules = [];
    const resumedChats = [];
    const blockedChats = [];
    let settledCount = 0;

    transaction(() => {
      for (const rule of rules) {
        // 自愈：等不到开盘信号的 armed 必须清掉，否则规则 × 群永久不判定
        if (ruleStateDao.clearStaleArmed(rule.id, chatId, ARMED_TTL_MS)) {
          logger.warn(
            `[STRATEGY_EXEC] 规则=${rule.id} 群=${maskChatId(chatId)} 待发超时已清理（未等到开盘信号）`
          );
        }

        let state = ruleStateDao.ensure(rule.id, chatId);

        // ── 先结算：挂起中的实发注，直接用本条开奖点数判定 ──
        // 结算会更新连败数，必须先于下面的触发判定与连败清零
        if (state.pending_direction) {
          settledCount += this._settlePendingWithDice(
            botUserId, rule, chatId, diceEntry, state, blockedChats
          );
          state = ruleStateDao.ensure(rule.id, chatId);
        }

        if (!canArm) continue;

        // 本群已单独停注：不下注，只观察连击是否重新满足（满足则自动恢复）
        if (state.blocked) {
          const resumed = this._evalBlockedResume(
            botUserId, rule, chatId, dice.value, state, armedRules
          );
          if (resumed) resumedChats.push(resumed);
          continue;
        }

        // 待发 / 挂起期间不重复触发
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

    await this._afterSettlement(botUserId, {
      settledCount, armedRules, resumedChats, blockedChats,
    });

    return armedRules.length;
  }

  /**
   * 开盘信号入口（识别到底注：1u）：把「待发」的下注真正发送出去
   *
   * 关键：只有「发送成功」才置 pending，失败则清掉 armed（本轮放弃），
   * 避免 pending 卡死导致该规则 × 群永久不再下注。
   *
   * 另外两件事：
   *   1. 记录本期期号（开盘消息带「期号: xxx」），作为注单 ↔ 开奖的关联键
   *   2. 兜底结算：上一期的骰子与结算消息都被错过、而本期开盘信号已到时，
   *      用已捕获的骰子（注单创建后到达的第一条）判定上期挂起注的输赢，
   *      不让挂起跨期滞留（没等到上期开奖信息 + 新开盘信号已到 → 用已获取的信息判定）
   *
   * @param {string} botUserId
   * @param {string} chatId
   * @param {string|null} text - 开盘消息文本（用于解析期号）
   */
  async handleRoundOpen(botUserId, chatId, text) {
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

    // 记录本期期号（解析不到时为 null，后续结算按无期号兼容处理）
    const period = parseWindowPeriod(text);
    this._chatRounds.set(chatId, { period, atMs: Date.now() });

    const candidates = [];
    const blockedChats = [];
    let settledCount = 0;

    transaction(() => {
      for (const rule of rules) {
        if (ruleStateDao.clearStaleArmed(rule.id, chatId, ARMED_TTL_MS)) {
          logger.warn(
            `[STRATEGY_EXEC] 规则=${rule.id} 群=${maskChatId(chatId)} 待发超时已清理（未等到开盘信号）`
          );
        }

        let state = ruleStateDao.ensure(rule.id, chatId);

        // 本群已单独停注（连败/止损达上限）→ 不下注，等连击重新满足自动恢复
        if (state.blocked) continue;

        // ── 兜底结算：上期挂起注在此了结（详见方法注释） ──
        if (state.pending_direction) {
          settledCount += this._sweepPendingAtRoundOpen(
            botUserId, rule, chatId, blockedChats
          );
          state = ruleStateDao.ensure(rule.id, chatId);
        }

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
          round_period: period,
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

    await this._afterSettlement(botUserId, {
      settledCount, armedRules: [], resumedChats: [], blockedChats,
    });

    if (candidates.length > 0 && this.notification) {
      await this.notification.pushToUser(botUserId).catch(() => {});
    }

    return candidates.length;
  }

  /**
   * 结算消息入口（❤️第xxx期输赢）
   *
   * 输赢判定已改为「开奖点数直接判定」（见类注释），结算消息降级为三个角色：
   *   1. 赔率学习：名单中奖行（赢÷投注额）→ chat_odds（分发器统一做，每消息一次）
   *   2. 兜底结算：某期骰子消息被错过时，该期挂起注用结算消息里的
   *      「骰子为: N」点数判定 —— 但期号必须与注单一致，绝不再拿别期名单判输赢
   *      （1525 错判的根因：上一期结算消息丢失 → 下一期名单里没有本账号 → 误记输）
   *   3. 盈利修正：名单里出现本账号的中奖行 → 把估算盈利修正为精确值
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

        // ── 实发注兜底结算：骰子消息被错过时，用同期结算消息里的点数判定 ──
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
          } else if (pending.round_period && settle.period
            && pending.round_period !== settle.period) {
            // ── 期号不一致：这注不属于本期，绝不用别期点数/名单判它 ──
            // 等它自己那期的骰子消息或结算消息，或超时巡检兜底
            logger.info(
              `[STRATEGY_EXEC] 结算期号=${settle.period} 与挂起注单期号=${pending.round_period} ` +
              `不一致，跳过（等待同期开奖）: 规则=${rule.id}, 群=${maskChatId(chatId)}, 动作=${pending.action_text}`
            );
          } else if (settle.diceValue != null) {
            // 名单里有本账号 → 用名单精确盈亏；否则按群赔率估算
            const isWin = this._judgeWin(pending.direction, settle.diceValue);
            const profit = (settle.matched && settle.isWin && settle.profit != null)
              ? settle.profit
              : (isWin ? this._winProfit(chatId, pending.bet_amount) : -pending.bet_amount);
            settledCount += this._applySettlement(
              botUserId, rule, chatId, pending, settle.diceValue, isWin, profit,
              state, blockedChats, '结算消息'
            );
          }
        } else {
          // ── 模拟注：按开奖点数判定输赢（不产生盈亏金额；期号不一致则跳过） ──
          const dry = actionLogDao.getLatestUnsettledDry(rule.id, chatId);
          if (dry && settle.diceValue != null
            && (!dry.round_period || !settle.period || dry.round_period === settle.period)) {
            const isWin = this._judgeWin(dry.direction, settle.diceValue);
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
        // 正常流程里骰子消息已先到、已在 handleOpen 里评估过（armed/pending 非空则跳过）；
        // 骰子被错过时，这里是唯一的评估时机。
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

    // 名单里有本账号的中奖行 → 把本期已结算赢单的估算盈利修正为精确值
    if (settle.matched && settle.isWin && settle.profit != null && settle.period) {
      const refined = actionLogDao.refineWinProfit(botUserId, chatId, settle.period, settle.profit);
      if (refined > 0) {
        logger.info(
          `[STRATEGY_EXEC] 盈利已按名单修正: 群=${maskChatId(chatId)}, 期=${settle.period}, ` +
          `盈亏→${settle.profit}（${refined} 笔）`
        );
      }
    }

    await this._afterSettlement(botUserId, {
      settledCount, armedRules, resumedChats: [], blockedChats,
    });

    return settledCount;
  }

  /**
   * 结算/恢复后的统一收尾：停注群通知、自动恢复通知、止盈检查、面板推送
   * @param {string} botUserId
   * @param {object} p
   * @param {number} p.settledCount - 本次结算的注单数
   * @param {Array} p.armedRules - 本次进入待发的规则
   * @param {Array} p.resumedChats - 本次自动恢复的停注群
   * @param {Array} p.blockedChats - 本次被停注的群
   */
  async _afterSettlement(botUserId, { settledCount, armedRules, resumedChats, blockedChats }) {
    // 停注群自动恢复通知
    for (const chat of resumedChats || []) {
      if (this.notification) {
        await this.notification.notifyEvent(
          botUserId,
          `▶️ 规则「${chat.rule.name || chat.rule.id}」@${maskChatId(chat.chatId)} ` +
            `连击重新满足，已自动恢复下注（连败已清零）。`
        ).catch(() => {});
      }
    }

    // 单群停注通知（规则仍在别的群继续运行）
    for (const { rule, chatId, reason } of blockedChats || []) {
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

    // 结算会让今日盈利变化 → 有结算就检查是否达到止盈目标
    if (settledCount > 0) {
      await this.checkTakeProfit(botUserId).catch((err) => logger.error(
        `[STRATEGY_EXEC] checkTakeProfit 异常: 用户=${botUserId}, ${err.message}`
      ));
    }

    if ((settledCount > 0 || armedRules.length > 0 || blockedChats.length > 0
      || (resumedChats && resumedChats.length > 0)) && this.notification) {
      await this.notification.pushToUser(botUserId).catch(() => {});
    }
  }

  /**
   * 记录本群最新骰子（开奖消息入口调用）
   * 保留最近 DICE_HISTORY_SIZE 条：发送在途的注单确认后按期号/时间补结算用
   * 多账号共听同一群时同一条骰子会分发多次，按 msg_id 去重只记一次
   *
   * @returns {object} 本次开奖的完整记录 { value, period, msgId, capturedAtMs }
   */
  _rememberDice(chatId, dice) {
    const history = this._diceHistory.get(chatId) || [];
    if (history[0] && String(history[0].msgId) === String(dice.msgId)) return history[0];
    const round = this._chatRounds.get(chatId) || null;
    const entry = {
      value: dice.value,
      period: round ? round.period : null,
      msgId: dice.msgId,
      capturedAtMs: Date.now(),
    };
    history.unshift(entry);
    if (history.length > DICE_HISTORY_SIZE) history.length = DICE_HISTORY_SIZE;
    this._diceHistory.set(chatId, history);
    return entry;
  }

  /**
   * 点数判输赢：大=4-6 / 小=1-3，与下注方向比对
   * @param {string} direction - 'BIG'|'SMALL'
   * @param {number} diceValue - 1-6
   * @returns {0|1}
   */
  _judgeWin(direction, diceValue) {
    return sizeOf(diceValue) === direction ? 1 : 0;
  }

  /**
   * 群赔率（无样本时用默认值）
   */
  _oddsFor(chatId) {
    const learned = chatOddsDao.getOdds(chatId);
    return learned != null ? learned : DEFAULT_PAYOUT_ODDS;
  }

  /**
   * 赢单盈利估算：下注金额 × 群赔率（保留两位）
   */
  _winProfit(chatId, betAmount) {
    return Math.round(Number(betAmount) * this._oddsFor(chatId) * 100) / 100;
  }

  /**
   * 找到某笔下注所属期的骰子：注单创建之后捕获的第一条骰子就是它那期的开奖
   *
   * 期号校验：双方期号都已知且不一致 → 不匹配（该期骰子没被捕获到，宁可等也不猜）
   *
   * @param {string} chatId
   * @param {number} betMs - 注单创建时间（epoch ms）
   * @param {string|null} period - 注单期号（未知传 null）
   * @returns {object|null} { value, period, msgId, capturedAtMs }
   */
  _findDiceForBet(chatId, betMs, period) {
    if (betMs == null) return null;
    const history = this._diceHistory.get(chatId) || [];
    const after = history.filter((d) => d.capturedAtMs > betMs); // 新→旧
    if (after.length === 0) return null;
    if (period) {
      // 期号已知：只认同期骰子（历史里 newest→oldest，先查最新的，回溯到最早）
      const matched = after.filter((d) => d.period === period);
      return matched.length ? matched[matched.length - 1] : null;
    }
    // 期号未知（重启后还没见过开盘消息）：取创建后最早的一条 = 该注所属期。
    // 但若注单老到早于捕获窗口里最旧的一条骰子，它所属期的骰子已不在窗口内，
    // 「最早的一条」其实是更晚的期 —— 宁可留着等超时巡检，也不跨期猜
    const oldest = history[history.length - 1];
    if (oldest && betMs < oldest.capturedAtMs) return null;
    return after[after.length - 1];
  }

  /**
   * 开奖点数结算挂起注单（骰子消息入口调用，需在事务内）
   *
   * @returns {number} 结算的注单数（0 或 1）
   */
  _settlePendingWithDice(botUserId, rule, chatId, dice, state, blockedChats) {
    const pending = actionLogDao.getLatestUnsettledSent(rule.id, chatId);

    if (!pending) {
      // 自愈：挂起但没有可结算的已发记录。发送在途保护窗口内不清（正在发送，
      // 确认后由 handleBetConfirmed 补结算）；否则清掉（发送失败遗留）
      const inFlight = actionLogDao.getRecentCreated(rule.id, chatId, SEND_IN_FLIGHT_GUARD_SECONDS);
      if (inFlight) {
        logger.info(
          `[STRATEGY_EXEC] 开奖到达但下注仍在发送中，等发送确认后补结算: ` +
          `规则=${rule.id}, 群=${maskChatId(chatId)}, 动作=${inFlight.action_text}`
        );
        return 0;
      }
      ruleStateDao.updateState(rule.id, chatId, { pendingDirection: null });
      logger.warn(
        `[STRATEGY_EXEC] 挂起状态无对应已发记录，已自愈清除: 规则=${rule.id}, 群=${maskChatId(chatId)}`
      );
      return 0;
    }

    const betMs = beijingTimeToMs(pending.created_at);
    const round = this._chatRounds.get(chatId);

    // 跨期保护：注单早于当前开盘窗口 → 它属于上一期（上期开奖被完整错过），
    // 不能用本期点数判它（留给结算消息期号匹配 / 超时巡检）
    if (round && betMs != null && betMs < round.atMs) {
      logger.warn(
        `[STRATEGY_EXEC] 挂起注单早于当前开盘窗口（疑似上期开奖被错过），跳过本期点数结算: ` +
        `规则=${rule.id}, 群=${maskChatId(chatId)}, 动作=${pending.action_text}`
      );
      return 0;
    }

    // 期号保护：双方期号都已知且不一致 → 这条骰子不是这注的开奖
    if (pending.round_period && dice.period
      && pending.round_period !== dice.period) {
      logger.warn(
        `[STRATEGY_EXEC] 骰子期号=${dice.period} 与挂起注单期号=${pending.round_period} 不一致，跳过结算: ` +
        `规则=${rule.id}, 群=${maskChatId(chatId)}, 动作=${pending.action_text}`
      );
      return 0;
    }

    const isWin = this._judgeWin(pending.direction, dice.value);
    const profit = isWin ? this._winProfit(chatId, pending.bet_amount) : -pending.bet_amount;
    return this._applySettlement(
      botUserId, rule, chatId, pending, dice.value, isWin, profit,
      state, blockedChats, '骰子'
    );
  }

  /**
   * 开盘信号到达时的兜底结算（需在事务内）
   *
   * 场景：上一期的骰子消息与结算消息都被错过（轮询窗口跳过 / 监听断档），
   * 挂起注跨期滞留。既然本期开盘信号已到（上期已结束），就用内存里
   * 已捕获的骰子（注单创建后到达的第一条）判定上期挂起注的输赢。
   *
   * @returns {number} 结算的注单数（0 或 1）
   */
  _sweepPendingAtRoundOpen(botUserId, rule, chatId, blockedChats) {
    const pending = actionLogDao.getLatestUnsettledSent(rule.id, chatId);
    if (!pending) {
      // 自愈：无在途发送才清（与开奖路径同一规则）
      const inFlight = actionLogDao.getRecentCreated(rule.id, chatId, SEND_IN_FLIGHT_GUARD_SECONDS);
      if (!inFlight) {
        ruleStateDao.updateState(rule.id, chatId, { pendingDirection: null });
        logger.warn(
          `[STRATEGY_EXEC] 挂起状态无对应已发记录，已自愈清除: 规则=${rule.id}, 群=${maskChatId(chatId)}`
        );
      }
      return 0;
    }

    const dice = this._findDiceForBet(
      chatId, beijingTimeToMs(pending.created_at), pending.round_period
    );
    if (!dice) return 0; // 没有任何已捕获点数 → 留给结算消息期号匹配 / 超时巡检

    const isWin = this._judgeWin(pending.direction, dice.value);
    const profit = isWin ? this._winProfit(chatId, pending.bet_amount) : -pending.bet_amount;
    logger.info(
      `[STRATEGY_EXEC] 开盘兜底结算（上期开奖消息被错过，用已捕获点数）: ` +
      `规则=${rule.id}, 群=${maskChatId(chatId)}, 动作=${pending.action_text}, 点数=${dice.value}`
    );
    const state = ruleStateDao.ensure(rule.id, chatId);
    return this._applySettlement(
      botUserId, rule, chatId, pending, dice.value, isWin, profit,
      state, blockedChats, '开盘兜底'
    );
  }

  /**
   * 下注确认成功（✅ 投注成功播报到达）后的补结算入口
   *
   * 常规流程：确认播报远早于开奖 → 无骰子可匹配 → 直接返回（等开奖）。
   * 兜底流程：发送在途时开奖已到（发送太慢/重试成功）→ 该注所属期的点数
   * 已在内存里，立即补结算，否则下一期开奖会错误地结算这期注单。
   *
   * @param {string} botUserId
   * @param {string} chatId
   * @param {object} bet - action_logs 行（getByBetMsgId 取到）
   * @param {string} text - 播报文本（含「期号: xxx」）
   */
  async handleBetConfirmed(botUserId, chatId, bet, text) {
    if (!bet || bet.rule_id == null) return;

    const fresh = actionLogDao.getById(bet.id);
    if (!fresh || fresh.status !== 'SENT' || fresh.settled_at) return; // 已结算/失败不处理

    // 播报里的期号 = 游戏方确认的注单归属期；补全缺失的 round_period
    const period = parseWindowPeriod(text);
    if (period && !fresh.round_period) {
      actionLogDao.updateRoundPeriodIfEmpty(fresh.id, period);
    }

    const state = ruleStateDao.ensure(fresh.rule_id, chatId);
    if (!state.pending_direction) return;

    const dice = this._findDiceForBet(
      chatId, beijingTimeToMs(fresh.created_at), period || fresh.round_period
    );
    if (!dice) return;

    const rule = ruleDao.getById(fresh.rule_id);
    if (!rule) return;

    const blockedChats = [];
    let settledCount = 0;
    transaction(() => {
      const isWin = this._judgeWin(fresh.direction, dice.value);
      const profit = isWin ? this._winProfit(chatId, fresh.bet_amount) : -fresh.bet_amount;
      settledCount = this._applySettlement(
        botUserId, rule, chatId, fresh, dice.value, isWin, profit,
        state, blockedChats, '发送确认补结算'
      );
    });

    await this._afterSettlement(botUserId, {
      settledCount, armedRules: [], resumedChats: [], blockedChats,
    });
  }

  /**
   * 写入结算结果 + 连败更新 + 停注硬约束（骰子/结算消息/兜底三条路径共用）
   * 需在事务内调用
   *
   * @param {object} pending - action_logs 行（未结算的实发注）
   * @param {number} diceValue - 用于判定的开奖点数
   * @param {0|1} isWin
   * @param {number} profit
   * @param {object} state - rule_chat_state 行（调用方读取，含连败数）
   * @param {Array} blockedChats - 停注群收集器
   * @param {string} source - 结算来源（日志用）：'骰子'|'结算消息'|'开盘兜底'|'发送确认补结算'
   * @returns {number} 实际结算的行数（0=已被并发结算）
   */
  _applySettlement(botUserId, rule, chatId, pending, diceValue, isWin, profit, state, blockedChats, source) {
    const changed = actionLogDao.markSettled(pending.id, isWin, profit);
    if (!changed) return 0;

    const newLosses = isWin ? 0 : state.consecutive_losses + 1;
    ruleStateDao.updateState(rule.id, chatId, {
      consecutiveLosses: newLosses,
      pendingDirection: null,
    });

    logger.info(
      `[STRATEGY_EXEC] 结算: 规则=${rule.id}, 群=${maskChatId(chatId)}, 方向=${pending.direction}, ` +
      `点数=${diceValue}, ${isWin ? '赢' : '输'} 盈亏=${profit != null ? profit : '-'}, ` +
      `连败=${newLosses}` +
      `${source === '骰子' ? `（赔率×${this._oddsFor(chatId)}）` : `（${source}）`}`
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
      blockedChats.push({
        rule, chatId,
        reason: `连续未中 ${newLosses} 次，已达连败上限 ${rule.max_lose_streak}`,
      });
      ruleStateDao.blockChat(rule.id, chatId,
        `连续未中 ${newLosses} 次，已达连败上限 ${rule.max_lose_streak}`);
      return 1;
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
        return 1;
      }
    }
    return 1;
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
   * 余额初始化完成通知（用户点「🔍 初始化余额」后）
   *
   * @param {string} botUserId
   * @param {number} balance - 查询到的余额（已写入当前余额与初始余额）
   */
  async notifyBalanceInitialized(botUserId, balance) {
    operationLogDao.insert({
      bot_user_id: botUserId,
      action: 'BALANCE_INITIALIZED',
      detail: `余额初始化完成：${balance}（已设为初始余额）`,
    });
    logger.info(`[STRATEGY_EXEC] 余额初始化: 用户=${botUserId}, 余额=${balance}`);

    if (this.notification) {
      await this.notification.notifyEvent(
        botUserId,
        `✅ <b>余额初始化完成</b>\n当前余额：${balance}\n` +
        `已记录为初始余额，亏损预警以此为基准。`
      ).catch(() => {});
      await this.notification.pushToUser(botUserId).catch(() => {});
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
