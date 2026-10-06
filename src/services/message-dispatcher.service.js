// src/services/message-dispatcher.service.js
const monitoredChatDao = require('../db/monitored-chat.dao');
const messageLogDao = require('../db/message-log.dao');
const actionLogDao = require('../db/action-log.dao');
const accountDao = require('../db/account.dao');
const logger = require('../utils/logger');
const { maskChatId } = require('../utils/mask.util');
const {
  parseDiceMessage, isSettleMessage, parseBalance, parseBetResult,
  isBalanceQueryReply, parseBalanceQuery, getReplyToMsgId, isBalanceForNickname,
} = require('../core/dice.parser');
const { isBetWindowMessage } = require('./strategy-executor.service');
const { get: getConfigValue } = require('../utils/config.loader');

/**
 * 消息分发服务（唯一的消息入口）
 *
 * 职责：
 *   - 消息分类：骰子开奖 / 结算消息 / 开盘信号
 *   - 全局去重：message_logs UNIQUE(chat_id, msg_id)，同一条消息
 *     无论从哪个入口到来（NewMessage 监听、轮询兜底、多个账号共用同一群），
 *     只入库一条、只处理一次。此前结算消息与开盘信号没有去重，
 *     监听与轮询双通道重复投递会导致：同一注被旧结算提前结算、
 *     重复待发后同一期下两注（重复下注）、发送在途时挂起被自愈误清（漏结算）。
 *   - 按群分发：分发给全部「在线且开启监听」的监听账号，
 *     各账号的规则 / 挂起状态 / 结算名单匹配彼此独立，互不影响。
 *
 * 接口：
 *   dispatch(message, chatId)
 */
class MessageDispatcherService {
  /**
   * @param {object} deps
   * @param {object} deps.sessionManager
   * @param {object} deps.strategyExecutor
   */
  constructor(deps) {
    this.sessionManager = deps.sessionManager;
    this.strategyExecutor = deps.strategyExecutor;
  }

  /**
   * 消息处理主流程：分类 → 全局去重入库 → 按群分发
   *
   * @param {object} message - GramJS Message（NewMessage 事件或 getMessages 结果）
   * @param {string|null} chatId - 群 ID（轮询调用方必须显式传入）
   */
  async dispatch(message, chatId) {
    if (!message || !chatId) return;

    // 分发目标：监听该群、账号在线、且开启了监听的账号
    const targets = monitoredChatDao.listActiveUsersByChat(chatId)
      .filter((userId) => this.sessionManager.getClient(userId));
    if (targets.length === 0) return;

    // 消息分类：骰子开奖 → 触发判定；结算消息 → 判输赢；开盘信号 → 发下注
    const dice = parseDiceMessage(message);
    let kind;
    let value = null;
    if (dice) {
      kind = 'dice';
      value = dice.value;
    } else if (isSettleMessage(message.message)) {
      kind = 'settle';
    } else if (isBetWindowMessage(message.message)) {
      kind = 'window';
    } else if (isBalanceQueryReply(message.message)) {
      // 主动查询余额的回复：发「余额」后机器人回的（含昵称+ID+各币种）
      // 必须先于 parseBalance 判定——它同样含「余额」字样，会被误判成下注播报
      kind = 'balance_query';
    } else if (parseBalance(message.message) != null) {
      // 余额播报：机器人对某条下注的回复（形如 💰余额：1123690.20 JIBA）
      kind = 'balance';
    } else {
      return;
    }

    // ── 余额类消息：必须先确认归属，只写本账号的余额 ──
    //   下注播报：靠「回复的是不是自己那条下注消息」
    //   主动查询回复：靠 🆔 ID 匹配（最可靠），ID 取不到再靠昵称
    // 任一条不满足 → 丢弃，绝不猜测（别人的余额绝不能记到自己账上）
    let balanceOwner = null;
    let bet = null;
    if (kind === 'balance') {
      const resolved = this._resolveBalanceOwner(message, chatId, targets);
      balanceOwner = resolved ? resolved.owner : null;
      bet = resolved ? resolved.bet : null;
      if (!balanceOwner) {
        logger.debug(
          `[DISPATCH] 余额播报无法归属本账号，已忽略: 群=${maskChatId(chatId)}, 消息=${message.id}`
        );
        return;
      }
    } else if (kind === 'balance_query') {
      balanceOwner = this._resolveQueryOwner(message, targets);
      if (!balanceOwner) {
        logger.debug(
          `[DISPATCH] 余额查询回复不属于本账号，已忽略: 群=${maskChatId(chatId)}, 消息=${message.id}`
        );
        return;
      }
    }

    // 全局去重：谁先入库谁处理，其余入口（监听/轮询/其他账号）直接丢弃
    const isNew = messageLogDao.insert({
      bot_user_id: balanceOwner || targets[0],
      chat_id: chatId,
      msg_id: String(message.id),
      sender_id: message.senderId ? message.senderId.toString() : null,
      msg_type: kind,
      value,
      raw_text: typeof message.message === 'string' ? message.message : '',
    });
    if (!isNew) return;

    if (kind === 'dice') {
      logger.info(
        `[DISPATCH] 开奖: 群=${maskChatId(chatId)}, 点数=${dice.value}, ` +
        `消息=${message.id}, 分发账号=${targets.length}个`
      );
      for (const userId of targets) {
        await this.strategyExecutor.handleOpen(userId, chatId, dice)
          .catch((err) => logger.error(`[DISPATCH] handleOpen 异常: 用户=${userId}, ${err.message}`));
      }
      return;
    }

    if (kind === 'settle') {
      for (const userId of targets) {
        await this.strategyExecutor.handleSettleMessage(userId, chatId, message.message)
          .catch((err) => logger.error(`[DISPATCH] handleSettleMessage 异常: 用户=${userId}, ${err.message}`));
      }
      return;
    }

    if (kind === 'balance_query') {
      // 主动查询回复：取下注用的 JIBA 币种作为余额
      const { jiba } = parseBalanceQuery(message.message);
      if (jiba == null) {
        logger.debug(`[DISPATCH] 余额查询回复未解析到 JIBA，已忽略: 消息=${message.id}`);
        return;
      }
      const before = accountDao.getActive(balanceOwner);
      const wasDepleted = before && before.balance != null && Number(before.balance) <= 0;
      accountDao.updateBalance(balanceOwner, jiba);
      logger.info(
        `[DISPATCH] 余额查询更新: 用户=${balanceOwner}, 群=${maskChatId(chatId)}, JIBA=${jiba}`
      );

      // 余额从「见底」恢复 → 通知用户已自动恢复下注
      if (wasDepleted && jiba > 0 && this.strategyExecutor) {
        await this.strategyExecutor.notifyBalanceRestored(balanceOwner, jiba).catch((err) =>
          logger.error(`[DISPATCH] notifyBalanceRestored 异常: ${err.message}`)
        );
      }
      return;
    }

    if (kind === 'balance') {
      const balance = parseBalance(message.message);
      accountDao.updateBalance(balanceOwner, balance);
      logger.info(
        `[DISPATCH] 余额更新: 用户=${balanceOwner}, 群=${maskChatId(chatId)}, 余额=${balance}`
      );

      // 同一条回复同时表明投注成败：
      //   ✅ 投注成功 → 正常，保留挂起等结算
      //   ❌ 余额不足等 → 这笔根本没投出去，必须立刻作废，
      //      否则会一直挂起等结算，把「规则 × 群」卡死
      const result = parseBetResult(message.message);
      if (!result.success && bet) {
        await this.strategyExecutor.handleBetRejected(
          balanceOwner, chatId, bet, result.reason
        ).catch((err) => logger.error(
          `[DISPATCH] handleBetRejected 异常: 用户=${balanceOwner}, ${err.message}`
        ));
      }

      // 余额刷新后检查：亏损过半预警 / 余额见底停注
      await this.strategyExecutor.checkBalanceAlerts(balanceOwner).catch((err) => logger.error(
        `[DISPATCH] checkBalanceAlerts 异常: 用户=${balanceOwner}, ${err.message}`
      ));
      return;
    }

    for (const userId of targets) {
      await this.strategyExecutor.handleRoundOpen(userId, chatId)
        .catch((err) => logger.error(`[DISPATCH] handleRoundOpen 异常: 用户=${userId}, ${err.message}`));
    }
  }

  /**
   * 判定「主动查询余额」的回复属于哪个账号
   *
   * 群里每个人查余额都会收到一条，全都在同一条消息流里，因此必须认人：
   *   ① 🆔 ID 与账号的 TG 用户 ID 完全一致 → 命中（最可靠，优先）
   *   ② ID 取不到时，用 .env BALANCE_NICKNAME 比对 👤 昵称（只在首行比，
   *      避免「可乐」误命中「可乐2」）
   *   ③ 命中人还必须在监听本群（targets）
   * 都不满足 → 返回 null，绝不猜测。
   *
   * @param {object} message
   * @param {string[]} targets - 正在监听本群的账号
   * @returns {string|null}
   */
  _resolveQueryOwner(message, targets) {
    const { userId } = parseBalanceQuery(message.message);
    const targetSet = targets.map(String);

    // ① ID 精确匹配
    if (userId && targetSet.includes(String(userId))) return String(userId);

    // ② 昵称兜底（需配置 BALANCE_NICKNAME）
    let nickname = null;
    try {
      nickname = getConfigValue('balanceNickname');
    } catch (_) {
      nickname = null;
    }
    if (nickname && isBalanceForNickname(message.message, nickname)) {
      // 昵称命中的账号必须在监听本群；只有一个监听账号时直接认它
      if (targetSet.length === 1) return targetSet[0];
    }

    return null;
  }

  /**
   * 判定一条余额播报属于哪个账号
   *
   * 群里每个人下注后机器人都会回复一条余额播报，全都长得一样，
   * 因此只能靠「这条消息回复的是谁的下注消息」来区分：
   *   1. 消息必须是回复消息（reply_to）
   *   2. 被回复的 msg_id 必须命中本群 action_logs 里我们发出的下注消息
   *   3. 该下注记录的账号必须在监听本群（targets）
   * 另外：若 .env 配了 BALANCE_NICKNAME（自己在本群的下注昵称），
   * 还要求播报里出现该昵称，双重确认，避免同群多账号串账。
   *
   * @param {object} message
   * @param {string} chatId
   * @param {string[]} targets - 正在监听本群的账号
   * @returns {{owner: string, bet: object}|null} 归属账号与该笔下注记录；无法归属返回 null
   */
  _resolveBalanceOwner(message, chatId, targets) {
    const replyToMsgId = getReplyToMsgId(message);
    if (!replyToMsgId) return null;

    const bet = actionLogDao.getByBetMsgId(chatId, replyToMsgId);
    if (!bet) return null;

    const owner = String(bet.bot_user_id);
    if (!targets.map(String).includes(owner)) return null;

    // 可选昵称校验（.env BALANCE_NICKNAME）
    let nickname = null;
    try {
      nickname = getConfigValue('balanceNickname');
    } catch (_) {
      nickname = null;
    }
    if (nickname && !String(message.message || '').includes(nickname)) return null;

    return { owner, bet };
  }
}

module.exports = MessageDispatcherService;
