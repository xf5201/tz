// src/services/dice-poller.service.js
const accountDao = require('../db/account.dao');
const monitoredChatDao = require('../db/monitored-chat.dao');
const messageLogDao = require('../db/message-log.dao');
const logger = require('../utils/logger');
const { maskChatId } = require('../utils/mask.util');
const { parseDiceMessage, isSettleMessage } = require('../core/dice.parser');
const { isBetWindowMessage } = require('./strategy-executor.service');

/**
 * 骰子开奖轮询服务（与 pc28 的 crawler.service 同构：拉取代替推送）
 *
 * 背景：实测部分群组（如某些博彩群）Telegram 服务器不向连接推送实时更新
 * （Raw 层 0 推送，但 getMessages 拉取正常、账号成员身份正常），
 * 因此在 NewMessage 监听之外增加按群轮询兜底：
 *   - 每 DICE_POLL_INTERVAL_MS 轮询一轮全部在线账号的全部监听群
 *   - 每群 getMessages(limit 5)，解析骰子开奖
 *   - 首轮只记录水位不补发历史（避免虚假连击）
 *   - 去重：message_logs UNIQUE(chat_id, msg_id) + 内存水位双保险，
 *     与 NewMessage 监听共存不会重复入库/重复触发
 */
// 单次消息拉取超时（毫秒）：GramJS 连接假死时 getMessages 会永久挂起
// （既不成功也不抛错），必须用超时兜底，否则轮询会无声卡死。
const GET_MESSAGES_TIMEOUT_MS = 15000;

class DicePollerService {
  /**
   * @param {object} deps
   * @param {object} deps.sessionManager
   * @param {object} deps.strategyExecutor
   * @param {number} deps.intervalMs - 轮询间隔
   */
  constructor(deps) {
    this.sessionManager = deps.sessionManager;
    this.strategyExecutor = deps.strategyExecutor;
    this.intervalMs = deps.intervalMs || 5000;
    this._timer = null;
    this._polling = false;
    this._round = 0;
    this._lastMsgId = new Map(); // "userId:chatId" → 已处理的最大消息 ID（水位）
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      void this.pollOnce();
    }, this.intervalMs);
    if (this._timer.unref) this._timer.unref();
    logger.info(`[DICE_POLLER] 轮询已启动: 间隔 ${this.intervalMs}ms`);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      logger.info('[DICE_POLLER] 轮询已停止');
    }
  }

  /**
   * 轮询一轮：全部在线账号的全部监听群
   */
  async pollOnce() {
    if (this._polling) return; // 防重叠：上一轮未结束时跳过
    this._polling = true;
    this._round++;
    if (this._round % 60 === 0) {
      logger.info(`[DICE_POLLER] 心跳: 已轮询 ${this._round} 轮，服务正常`);
    }
    try {
      for (const [userId, client] of this.sessionManager.getAllClients()) {
        const account = accountDao.getActive(userId);
        if (!account || account.status !== 'ACTIVE' || !account.listen_enabled) continue;

        const chats = monitoredChatDao.listByUser(userId);
        for (const chat of chats) {
          try {
            await this._pollChat(userId, client, chat.chat_id);
          } catch (err) {
            logger.warn(`[DICE_POLLER] 群 ${maskChatId(chat.chat_id)} 轮询失败: ${err.message}`);
          }
        }
      }
    } catch (err) {
      logger.error(`[DICE_POLLER] 轮询异常: ${err.message}`);
    } finally {
      this._polling = false;
    }
  }

  /**
   * 轮询单个群：取最近若干条，按水位增量处理（骰子开奖 + 底注开盘信号）
   */
  async _pollChat(userId, client, chatId) {
    const msgs = await this._getMessagesWithTimeout(client, chatId, 10);
    const key = `${userId}:${chatId}`;
    const watermark = this._lastMsgId.get(key) || 0;

    // 首轮：只建立水位（取最新一条消息 ID），不补发历史
    if (watermark === 0) {
      if (msgs.length) this._lastMsgId.set(key, Number(msgs[0].id));
      return;
    }

    // 旧 → 新逐条处理
    for (const m of msgs.reverse()) {
      const msgIdNum = Number(m.id);
      if (msgIdNum <= this._lastMsgId.get(key)) continue;
      this._lastMsgId.set(key, msgIdNum);

      const dice = parseDiceMessage(m);
      if (dice) {
        // 双保险去重（与 NewMessage 监听共存）：库内已存在则跳过
        const isNew = messageLogDao.insert({
          bot_user_id: userId,
          chat_id: chatId,
          msg_id: dice.msgId,
          sender_id: dice.senderId,
          msg_type: dice.msgType,
          value: dice.value,
          raw_text: dice.rawText,
        });
        if (!isNew) continue;

        logger.info(
          `[DICE_POLLER] 开奖: 用户=${userId}, 群=${maskChatId(chatId)}, ` +
          `点数=${dice.value}, 消息=${dice.msgId}`
        );
        await this.strategyExecutor.handleOpen(userId, chatId, dice);
      } else if (isSettleMessage(m.message)) {
        // 结算消息（❤️第xxx期输赢）：解析本账号输赢与盈亏
        await this.strategyExecutor.handleSettleMessage(userId, chatId, m.message);
      } else if (isBetWindowMessage(m.message)) {
        // 开盘信号（识别到底注：1u）：把「待发」的下注真正发送出去
        await this.strategyExecutor.handleRoundOpen(userId, chatId);
      }
    }
  }

  /**
   * 带超时保护的消息拉取；超时说明连接假死，主动重连后再抛错
   */
  async _getMessagesWithTimeout(client, chatId, limit, timeoutMs = GET_MESSAGES_TIMEOUT_MS) {
    return Promise.race([
      client.getMessages(chatId, { limit }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`getMessages 超时（${timeoutMs / 1000}s，连接假死）`)), timeoutMs)
      ),
    ]).catch(async (err) => {
      if (String(err.message).includes('getMessages 超时')) {
        logger.warn(`[DICE_POLLER] 群 ${maskChatId(chatId)} 拉取超时，尝试刷新连接`);
        try { await client.connect(); } catch (_) { /* 由下轮重试 */ }
      }
      throw err;
    });
  }
}

module.exports = DicePollerService;
