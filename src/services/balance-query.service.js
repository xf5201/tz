// src/services/balance-query.service.js
const monitoredChatDao = require('../db/monitored-chat.dao');
const logger = require('../utils/logger');
const { maskChatId } = require('../utils/mask.util');

/**
 * 主动余额查询服务
 *
 * 背景：余额不足会全局停注，停注后不再下注，也就收不到「机器人对自己下注的回复」，
 * 余额从此不再更新 —— 用户充值了系统也不知道，永远停在停注状态。
 *
 * 解决：往群里发「余额」两个字，机器人的回复带昵称 + ID + 各币种余额，
 * 据此更新余额，充值后即可自动恢复下注。
 *
 * 接口：
 *   queryBalance(botUserId)   → 向一个已监听群发送「余额」并等待回复
 */

// 发送超时（毫秒）：GramJS 连接假死时 sendMessage 会永久挂起
const SEND_TIMEOUT_MS = 20000;

// 查询节流：同一账号两次主动查询的最小间隔（防止刷群被踢）
const MIN_QUERY_INTERVAL_MS = 30 * 1000;

class BalanceQueryService {
  /**
   * @param {object} deps
   * @param {object} deps.sessionManager
   */
  constructor(deps) {
    this.sessionManager = deps.sessionManager;

    // botUserId → 上次主动查询时间（内存即可，重启清零）
    this._lastQueryAt = new Map();
  }

  /**
   * 主动查询余额：向一个已监听的群发送「余额」
   *
   * 只发一个群 —— 余额是账号维度的，查一次就够，避免在多个群里刷屏。
   *
   * @param {string} botUserId
   * @param {object} [options]
   * @param {boolean} [options.throttle=true] - 是否启用 30 秒节流
   * @returns {Promise<{sent: boolean, chatId: string|null, reason: string|null}>}
   */
  async queryBalance(botUserId, options = {}) {
    const throttle = options.throttle !== false;

    if (throttle) {
      const last = this._lastQueryAt.get(String(botUserId)) || 0;
      if (Date.now() - last < MIN_QUERY_INTERVAL_MS) {
        return { sent: false, chatId: null, reason: '查询过于频繁，已跳过' };
      }
    }

    const client = this.sessionManager.getClient(botUserId);
    if (!client) return { sent: false, chatId: null, reason: 'TG Client 未连接' };

    const chats = monitoredChatDao.listByUser(botUserId);
    if (chats.length === 0) return { sent: false, chatId: null, reason: '未配置监听群' };

    // 取第一个群（余额是账号维度的，查一个就够）
    const chatId = String(chats[0].chat_id);

    try {
      await Promise.race([
        client.sendMessage(chatId, { message: '余额' }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`发送超时（${SEND_TIMEOUT_MS / 1000}s）`)), SEND_TIMEOUT_MS)
        ),
      ]);

      this._lastQueryAt.set(String(botUserId), Date.now());
      logger.info(`[BALANCE_QUERY] 用户 ${botUserId} 已发送余额查询: 群=${maskChatId(chatId)}`);
      return { sent: true, chatId, reason: null };
    } catch (err) {
      logger.warn(`[BALANCE_QUERY] 用户 ${botUserId} 余额查询发送失败: ${err.message}`);
      return { sent: false, chatId, reason: err.message };
    }
  }
}

module.exports = BalanceQueryService;
