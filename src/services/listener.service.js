// src/services/listener.service.js
const { NewMessage } = require('telegram/events');

const monitoredChatDao = require('../db/monitored-chat.dao');
const logger = require('../utils/logger');

/**
 * 消息监听服务
 *
 * 职责：
 *   - 为每个已连接账号的 Client 注册 NewMessage 处理器
 *   - 收到消息后统一交给 MessageDispatcher：
 *     分类 → 按 (chat_id, msg_id) 全局去重入库 → 分发给全部监听该群的账号
 *   （多账号共用群时，同一条消息只入库一条、只处理一次；
 *     此前按账号各自处理，监听与轮询双通道重复投递结算/开盘消息
 *     会引发重复下注与漏结算）
 *
 * 接口：
 *   startForUser(botUserId, client)
 *   invalidateChatsCache(botUserId)   // 兼容保留：白名单已改为实时查库，无需刷新缓存
 *   stopByUser(botUserId)
 */
class ListenerService {
  /**
   * @param {object} deps
   * @param {object} deps.messageDispatcher - 消息分发服务
   */
  constructor(deps) {
    this.messageDispatcher = deps.messageDispatcher;

    // botUserId → { client }
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

    const chatCount = monitoredChatDao.listByUser(userId).length;

    client.addEventHandler(async (event) => {
      await this._onMessage(event).catch((err) => {
        logger.error(`[LISTENER] 用户 ${userId} 消息处理异常: ${err.message}`);
      });
    }, new NewMessage({}));

    this._listeners.set(userId, { client });
    logger.info(`[LISTENER] 用户 ${userId} 监听已启动: ${chatCount} 个群`);
  }

  /**
   * 监听群配置变更后刷新内存缓存
   * （兼容保留：分发目标已改为实时查库，本方法无需做任何事）
   * @param {string} botUserId
   */
  invalidateChatsCache(botUserId) {
    logger.info(`[LISTENER] 用户 ${String(botUserId)} 监听群配置已变更（实时查库，无需刷新）`);
  }

  /**
   * 停止账号监听（登出 / 删除账号时调用；Client 销毁后处理器随之失效）
   * @param {string} botUserId
   */
  stopByUser(botUserId) {
    this._listeners.delete(String(botUserId));
  }

  /**
   * 消息处理：交给分发器（分类 → 去重 → 按群分发）
   */
  async _onMessage(event) {
    const message = event?.message;
    if (!message) return;

    const chatId = message.chatId ? message.chatId.toString() : null;
    await this.messageDispatcher.dispatch(message, chatId);
  }
}

module.exports = ListenerService;
