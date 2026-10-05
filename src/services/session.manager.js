// src/services/session.manager.js
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const accountDao = require('../db/account.dao');
const ruleDao = require('../db/rule.dao');
const logger = require('../utils/logger');
const { maskPhone } = require('../utils/mask.util');

// 动态判断：有 http_proxy 环境变量就走代理，没有就直连
function getProxyConfig() {
  if (!process.env.http_proxy && !process.env.HTTP_PROXY) {
    return null;
  }
  return {
    ip: '127.0.0.1',
    port: 7890,
    socksType: 5,
    timeout: 10000,
  };
}

/**
 * TG Client 连接池管理
 *
 * 职责：
 *   - 管理所有用户的 TelegramClient 实例（内存 Map，按 botUserId 隔离）
 *   - 启动时从 DB 加载所有活跃 Session（loadActiveSessions）
 *   - 提供 getClient / initClient / destroyClient
 *
 * 接口：
 *   getClient(botUserId)
 *   initClient(botUserId, sessionString)
 *   destroyClient(botUserId)
 *   loadActiveSessions()
 *   getActiveCount() / destroyAll()
 */
class SessionManager {
  /**
   * @param {object} config - { apiId, apiHash }
   */
  constructor(config) {
    this.apiId = config.apiId;
    this.apiHash = config.apiHash;

    // botUserId → TelegramClient
    this._clients = new Map();
  }

  /**
   * 获取用户的 TG Client
   *
   * @param {string} botUserId
   * @returns {TelegramClient|null}
   */
  getClient(botUserId) {
    return this._clients.get(String(botUserId)) || null;
  }

  /**
   * 初始化单个用户的 TG Client
   *
   * @param {string} botUserId
   * @param {string} sessionString - 明文 Session 字符串
   * @param {object} hooks - { onConnected(botUserId, client), onFailed(botUserId, error) }
   * @returns {TelegramClient}
   */
  async initClient(botUserId, sessionString, hooks = {}) {
    const userId = String(botUserId);

    // 如果已有连接，先断开（避免同账号互踢）
    if (this._clients.has(userId)) {
      try {
        await this._clients.get(userId).disconnect();
      } catch (_) { /* ignore */ }
    }

    const session = new StringSession(sessionString);
    const proxy = getProxyConfig();

    const client = new TelegramClient(session, this.apiId, this.apiHash, {
      connectionRetries: 5,
      retryDelay: 2000,
      ...(proxy ? { proxy } : {}),
    });

    try {
      await client.connect();

      // 验证连接是否有效
      const me = await client.getMe();
      if (!me) {
        throw new Error('Client 连接后无法获取用户信息');
      }

      this._clients.set(userId, client);
      logger.info(`[SESSION] 用户 ${userId} Client 已连接${proxy ? ' (via proxy)' : ' (direct)'}`);

      if (hooks.onConnected) {
        await hooks.onConnected(userId, client);
      }

      return client;
    } catch (error) {
      logger.error(`[SESSION] 用户 ${userId} Client 连接失败: ${error.message}`);

      // 标记账号为 ERROR，并停用其全部启用规则（Session 失效，需重新登录恢复）
      accountDao.updateStatus(userId, 'ERROR', error.message);
      const enabledRules = ruleDao.listEnabledByUser(userId);
      for (const rule of enabledRules) {
        ruleDao.update(rule.id, { enabled: 0 });
      }
      if (enabledRules.length > 0) {
        logger.warn(`[SESSION] 用户 ${userId} 的 ${enabledRules.length} 条规则已自动停用（Session 失效）`);
      }

      try {
        await client.disconnect();
      } catch (_) { /* ignore */ }

      if (hooks.onFailed) {
        await hooks.onFailed(userId, error);
      }

      throw error;
    }
  }

  /**
   * 销毁用户的 TG Client
   *
   * @param {string} botUserId
   */
  async destroyClient(botUserId) {
    const userId = String(botUserId);
    const client = this._clients.get(userId);

    if (client) {
      try {
        await client.disconnect();
      } catch (error) {
        logger.warn(`[SESSION] 用户 ${userId} 断开连接异常: ${error.message}`);
      }
      this._clients.delete(userId);
      logger.info(`[SESSION] 用户 ${userId} Client 已销毁`);
    }
  }

  /**
   * 启动时加载所有活跃 Session
   *
   * 加载 status IN ('PENDING_SETUP', 'ACTIVE') 的账号
   * 逐个 initClient，失败则标记 status = ERROR
   */
  async loadActiveSessions(hooks = {}) {
    const accounts = accountDao.getAllForRecovery();

    if (accounts.length === 0) {
      logger.info('[SESSION] 没有需要恢复的 Session');
      return;
    }

    logger.info(`[SESSION] 开始恢复 ${accounts.length} 个 Session`);

    let successCount = 0;
    let failCount = 0;

    for (const account of accounts) {
      try {
        await this.initClient(account.bot_user_id, account.session_string, hooks);
        successCount++;
      } catch (error) {
        failCount++;
        logger.error(
          `[SESSION] 恢复失败: ${account.bot_user_id} (${maskPhone(account.phone)}) → ${error.message}`
        );
      }
    }

    logger.info(`[SESSION] Session 恢复完成: 成功 ${successCount}, 失败 ${failCount}`);
  }

  /**
   * 获取所有已连接的 Client 数量
   * @returns {number}
   */
  getActiveCount() {
    return this._clients.size;
  }

  /**
   * 遍历全部在线 Client（轮询服务使用）
   * @returns {Array<[string, TelegramClient]>} [botUserId, client] 数组
   */
  getAllClients() {
    return Array.from(this._clients.entries());
  }

  /**
   * 销毁所有 Client（优雅关闭）
   */
  async destroyAll() {
    const userIds = Array.from(this._clients.keys());
    for (const userId of userIds) {
      await this.destroyClient(userId);
    }
    logger.info('[SESSION] 所有 Client 已销毁');
  }
}

module.exports = SessionManager;
