// src/services/message-dispatcher.service.js
const monitoredChatDao = require('../db/monitored-chat.dao');
const messageLogDao = require('../db/message-log.dao');
const actionLogDao = require('../db/action-log.dao');
const accountDao = require('../db/account.dao');
const logger = require('../utils/logger');
const { maskChatId } = require('../utils/mask.util');
const {
  parseDiceMessage, isSettleMessage, parseBalance, getReplyToMsgId,
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
    } else if (parseBalance(message.message) != null) {
      // 余额播报：机器人对某条下注的回复（形如 💰余额：1123690.20 JIBA）
      kind = 'balance';
    } else {
      return;
    }

    // ── 余额播报：必须先确认归属，只写本账号的余额 ──
    // 判定链：① 必须是「回复某条消息」② 被回复的那条是本账号发出的下注消息
    //        ③ 该账号正在监听本群（在 targets 里）
    // 任一条不满足 → 丢弃，绝不猜测（别人的余额绝不能记到自己账上）
    let balanceOwner = null;
    if (kind === 'balance') {
      balanceOwner = this._resolveBalanceOwner(message, chatId, targets);
      if (!balanceOwner) {
        logger.debug(
          `[DISPATCH] 余额播报无法归属本账号，已忽略: 群=${maskChatId(chatId)}, 消息=${message.id}`
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

    if (kind === 'balance') {
      const balance = parseBalance(message.message);
      accountDao.updateBalance(balanceOwner, balance);
      logger.info(
        `[DISPATCH] 余额更新: 用户=${balanceOwner}, 群=${maskChatId(chatId)}, 余额=${balance}`
      );
      return;
    }

    for (const userId of targets) {
      await this.strategyExecutor.handleRoundOpen(userId, chatId)
        .catch((err) => logger.error(`[DISPATCH] handleRoundOpen 异常: 用户=${userId}, ${err.message}`));
    }
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
   * @returns {string|null} 归属的 bot_user_id；无法归属返回 null
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

    return owner;
  }
}

module.exports = MessageDispatcherService;
