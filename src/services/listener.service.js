// src/services/listener.service.js
const { NewMessage } = require('telegram/events');
const { Api } = require('telegram');

const accountDao = require('../db/account.dao');
const monitoredChatDao = require('../db/monitored-chat.dao');
const messageLogDao = require('../db/message-log.dao');
const logger = require('../utils/logger');
const { maskChatId } = require('../utils/mask.util');
const { parseDiceMessage, isSettleMessage } = require('../core/dice.parser');
const { isBetWindowMessage } = require('./strategy-executor.service');

/**
 * 消息监听服务
 *
 * 职责：
 *   - 为每个已连接账号的 Client 注册 NewMessage 处理器
 *   - 仅处理该用户勾选的监听群（多群白名单，内存缓存 + 变更时刷新）
 *   - 去重（message_logs UNIQUE(chat_id,msg_id) 兜底 + 内存短期待处理集合）
 *   - 解析骰子开奖消息 → 写流水 → 投递给策略执行器
 *
 * 接口：
 *   startForUser(botUserId, client)
 *   invalidateChatsCache(botUserId)
 *   stopByUser(botUserId)
 */
class ListenerService {
  /**
   * @param {object} deps
   * @param {object} deps.strategyExecutor - 策略执行器（handleOpen）
   */
  constructor(deps) {
    this.strategyExecutor = deps.strategyExecutor;

    // botUserId → { client, chatSet: Set<chatId> }
    this._listeners = new Map();
  }

  /**
   * 为账号启动监听
   * @param {string} botUserId
   * @param {import('telegram').TelegramClient} client
   */
  startForUser(botUserId, client) {
    const userId = String(botUserId);
    if (this._listeners.has(userId)) return;

    const chats = monitoredChatDao.listByUser(userId);
    const listener = {
      client,
      chatSet: new Set(chats.map((c) => c.chat_id)),
    };

    client.addEventHandler(async (event) => {
      await this._onMessage(userId, event).catch((err) => {
        logger.error(`[LISTENER] 用户 ${userId} 消息处理异常: ${err.message}`);
      });
    }, new NewMessage({}));

    this._listeners.set(userId, listener);
    logger.info(`[LISTENER] 用户 ${userId} 监听已启动: ${listener.chatSet.size} 个群`);
  }

  /**
   * 监听群配置变更后刷新内存缓存
   * @param {string} botUserId
   */
  invalidateChatsCache(botUserId) {
    const userId = String(botUserId);
    const listener = this._listeners.get(userId);
    if (!listener) return;
    const chats = monitoredChatDao.listByUser(userId);
    listener.chatSet = new Set(chats.map((c) => c.chat_id));
    logger.info(`[LISTENER] 用户 ${userId} 监听群缓存已刷新: ${listener.chatSet.size} 个群`);
  }

  /**
   * 停止账号监听（登出 / 删除账号时调用；Client 销毁后处理器随之失效）
   * @param {string} botUserId
   */
  stopByUser(botUserId) {
    this._listeners.delete(String(botUserId));
  }

  /**
   * 消息处理主流程：
   *   监听开关 → 群白名单 → 骰子解析 → 去重 → 流水入库 → 策略执行器
   */
  async _onMessage(userId, event) {
    const listener = this._listeners.get(userId);
    if (!listener) return;

    // 监听开关（暂停时不中断登录态）
    const account = accountDao.getActive(userId);
    if (!account || !account.listen_enabled) return;

    const message = event?.message;
    if (!message) return;

    const chatId = message.chatId ? message.chatId.toString() : null;
    if (!chatId || !listener.chatSet.has(chatId)) return;

    // 消息分类：骰子开奖 → 触发判定；结算消息 → 判输赢；开盘信号 → 发下注
    const dice = parseDiceMessage(message);
    if (!dice) {
      // 结算消息（❤️第xxx期输赢）：解析本账号输赢与盈亏
      if (isSettleMessage(message.message)) {
        await this.strategyExecutor.handleSettleMessage(userId, chatId, message.message);
        return;
      }
      // 开盘信号（识别到底注：1u）：把「待发」的下注真正发送出去
      if (isBetWindowMessage(message.message)) {
        await this.strategyExecutor.handleRoundOpen(userId, chatId);
      }
      return;
    }

    // 去重：数据库 UNIQUE(chat_id, msg_id) 兜底，重复消息直接丢弃
    const isNew = messageLogDao.insert({
      bot_user_id: userId,
      chat_id: chatId,
      msg_id: dice.msgId,
      sender_id: dice.senderId,
      msg_type: dice.msgType,
      value: dice.value,
      raw_text: dice.rawText,
    });
    if (!isNew) return;

    logger.info(
      `[LISTENER] 开奖: 用户=${userId}, 群=${maskChatId(chatId)}, ` +
      `点数=${dice.value}, 消息=${dice.msgId}`
    );

    // 投递给策略执行器（规则判定 + 自动下注）
    await this.strategyExecutor.handleOpen(userId, chatId, dice);
  }
}

module.exports = ListenerService;
