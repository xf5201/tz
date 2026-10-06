// src/services/message-dispatcher.service.js
const monitoredChatDao = require('../db/monitored-chat.dao');
const messageLogDao = require('../db/message-log.dao');
const logger = require('../utils/logger');
const { maskChatId } = require('../utils/mask.util');
const { parseDiceMessage, isSettleMessage } = require('../core/dice.parser');
const { isBetWindowMessage } = require('./strategy-executor.service');

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
    } else {
      return;
    }

    // 全局去重：谁先入库谁处理，其余入口（监听/轮询/其他账号）直接丢弃
    const isNew = messageLogDao.insert({
      bot_user_id: targets[0],
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

    for (const userId of targets) {
      await this.strategyExecutor.handleRoundOpen(userId, chatId)
        .catch((err) => logger.error(`[DISPATCH] handleRoundOpen 异常: 用户=${userId}, ${err.message}`));
    }
  }
}

module.exports = MessageDispatcherService;
