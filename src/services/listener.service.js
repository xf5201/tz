// src/services/listener.service.js (TDlib 接入版)
const monitoredChatDao = require("../db/monitored-chat.dao");
const logger = require("../utils/logger");

/**
 * 消息监听服务（TDlib 版）
 * TDlib 的新消息推送已由 tdlib.session 内部转成 { message } 结构并调用 handler。
 * 职责：
 *   - 为每个已连接账号注册 message handler（TDlib 增量推送）
 *   - 收到消息统一交给 MessageDispatcher
 */
class ListenerService {
  constructor(deps) {
    this.messageDispatcher = deps.messageDispatcher;
    this._listeners = new Map();
  }
  startForUser(botUserId, client) {
    const userId = String(botUserId);
    if (this._listeners.has(userId)) return;
    const chatCount = monitoredChatDao.listByUser(userId).length;
    // TDlib 版：client 已是 TdSessionClient，addEventHandler 由内部转结构
    client.addEventHandler(async (event) => {
      await this._onMessage(event).catch((err) => {
        logger.error(`[LISTENER][TDlib] 用户 ${userId} 消息处理异常: ${err.message}`);
      });
    });
    this._listeners.set(userId, { client });
    logger.info(`[LISTENER][TDlib] 用户 ${userId} 监听已启动: ${chatCount} 个群`);
  }
  invalidateChatsCache(botUserId) {
    logger.info(`[LISTENER][TDlib] 用户 ${String(botUserId)} 监听群配置已变更（实时查库，无需刷新）`);
  }
  stopByUser(botUserId) {
    this._listeners.delete(String(botUserId));
  }
  async _onMessage(event) {
    const message = event?.message;
    if (!message) return;
    const chatId = message.chatId ? message.chatId.toString() : null;
    await this.messageDispatcher.dispatch(message, chatId);
  }
}
module.exports = ListenerService;
