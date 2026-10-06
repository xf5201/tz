// src/services/bet-sender.service.js
const accountDao = require('../db/account.dao');
const ruleDao = require('../db/rule.dao');
const actionLogDao = require('../db/action-log.dao');
const operationLogDao = require('../db/operation-log.dao');
const logger = require('../utils/logger');
const { maskChatId } = require('../utils/mask.util');

// 下注消息发送超时（毫秒）：GramJS 连接假死时 sendMessage 会永久挂起
// （既不成功也不抛错），必须用超时兜底，否则该期下注会无声丢失。
const SEND_TIMEOUT_MS = 30000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [2000, 8000];

/**
 * 下注消息发送服务
 *
 * 职责：
 *   - 通过 TG Client 发送下注消息到监听群（指令格式："大 100"）
 *   - 成功 → status = SENT
 *   - Forbidden → status = FAILED + 账号 ERROR + 规则停用
 *   - 其他失败 → 指数退避重试，超限标记 FAILED
 *
 * 接口：
 *   sendBetMessage(botUserId, action)
 */
class BetSenderService {
  /**
   * @param {object} deps
   * @param {object} deps.sessionManager
   * @param {object} deps.notification
   */
  constructor(deps) {
    this.sessionManager = deps.sessionManager;
    this.notification = deps.notification;
  }

  /**
   * 发送下注消息
   *
   * @param {string} botUserId
   * @param {object} action - action_logs 行（含 id/chat_id/action_text）
   * @returns {Promise<boolean>} 是否真的发送成功（调用方据此决定是否进入挂起结算）
   */
  async sendBetMessage(botUserId, action) {
    const { id, chat_id, action_text } = action;

    logger.info(
      `[BET_SENDER] 用户 ${botUserId} 发送下注: ` +
      `群=${maskChatId(chat_id)}, 动作=${action_text}`
    );

    try {
      // 获取 TG Client
      const client = this.sessionManager.getClient(botUserId);
      if (!client) {
        throw new Error('TG Client 未连接');
      }

      // 发送消息到目标群（带超时保护）
      const sentMessage = await this._sendWithTimeout(client, chat_id, action_text);

      // 发送成功 → 更新状态为 SENT
      actionLogDao.markSent(id);
      logger.info(`[BET_SENDER] 用户 ${botUserId} 下注已发送: 消息=${sentMessage.id}`);
      return true;

      // 推送面板更新
      if (this.notification) {
        await this.notification.pushToUser(botUserId).catch(() => {});
      }
    } catch (error) {
      // 重试成功也算成功，必须把结果如实回传给调用方
      return await this._handleSendError(botUserId, action, error) === true;
    }
  }

  /**
   * 带超时保护的消息发送
   */
  async _sendWithTimeout(client, chatId, text, timeoutMs = SEND_TIMEOUT_MS) {
    return Promise.race([
      client.sendMessage(chatId, { message: text }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`发送超时（${timeoutMs / 1000}s）`)), timeoutMs)
      ),
    ]);
  }

  /**
   * 发送失败处理：指数退避重试，超限标记 FAILED 并告警
   */
  async _handleSendError(botUserId, action, error) {
    const description = error.description || error.message || '';

    // Forbidden → 账号被踢出群 / 权限问题：标记 ERROR 并停用规则
    if (description.includes('CHAT_WRITE_FORBIDDEN') || description.includes('Forbidden')) {
      actionLogDao.markFailed(action.id, '无发言权限（被踢出群或被禁言）');
      accountDao.updateStatus(botUserId, 'ERROR', '无发言权限');
      const enabledRules = ruleDao.listEnabledByUser(botUserId);
      for (const rule of enabledRules) {
        ruleDao.update(rule.id, { enabled: 0 });
      }
      operationLogDao.insert({
        bot_user_id: botUserId,
        action: 'BET_FAILED',
        detail: `群 ${maskChatId(action.chat_id)} 无发言权限，规则已停用`,
      });
      if (this.notification) {
        await this.notification.notifyEvent(
          botUserId,
          `⚠️ 群 ${maskChatId(action.chat_id)} 已无法发言（被踢出或禁言），动作失败，全部规则已停用。`
        ).catch(() => {});
      }
      return false;
    }

    // 其他失败：退避重试
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt - 1] || 8000));
      try {
        const client = this.sessionManager.getClient(botUserId);
        if (!client) throw new Error('TG Client 未连接');
        await this._sendWithTimeout(client, action.chat_id, action.action_text);
        actionLogDao.markFailed(action.id, null);
        actionLogDao.markSent(action.id);
        logger.info(`[BET_SENDER] 用户 ${botUserId} 重试第 ${attempt} 次成功`);
        return true;
      } catch (retryError) {
        logger.warn(`[BET_SENDER] 用户 ${botUserId} 重试第 ${attempt} 次失败: ${retryError.message}`);
        if (attempt === MAX_RETRIES) {
          actionLogDao.markFailed(action.id, retryError.message, attempt);
          operationLogDao.insert({
            bot_user_id: botUserId,
            action: 'BET_FAILED',
            detail: `动作 ${action.action_text} 多次发送失败: ${retryError.message}`,
          });
          if (this.notification) {
            await this.notification.notifyEvent(
              botUserId,
              `⚠️ 动作「${action.action_text}」多次发送失败，已放弃：${retryError.message}`
            ).catch(() => {});
          }
        }
      }
    }
    return false;
  }
}

module.exports = BetSenderService;
