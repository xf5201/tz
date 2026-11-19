// src/services/session.manager.js (TDlib 接入版)
// 底层从 gramjs 换成官方 TDlib（koffi + libtdjson.so），对外接口保持一致
const { TdSessionClient } = require("./tdlib.session");
const accountDao = require("../db/account.dao");
const ruleDao = require("../db/rule.dao");
const logger = require("../utils/logger");
const { maskPhone } = require("../utils/mask.util");
const { getDeviceProfile } = require("../utils/device-profile");

// 动态判断：有 TD_PROXY_PORT（或 http_proxy 环境变量）才走代理，否则直连（TDlib 内建 socks5）
// 生产机在海外直连 TG 即可，不需要代理；国内机器才配 TD_PROXY_PORT 指向本机 socks5
function getProxyConfig() {
  const port = Number(process.env.TD_PROXY_PORT);
  if (!port) return null;
  return { ip: "127.0.0.1", port, socksType: 5, timeout: 10000 };
}

/**
 * TG Client 连接池管理（TDlib 版）
 */
class SessionManager {
  constructor(config) {
    this.apiId = config.apiId;
    this.apiHash = config.apiHash;
    this._clients = new Map();
  }
  getClient(botUserId) {
    return this._clients.get(String(botUserId)) || null;
  }
  async initClient(botUserId, sessionString, hooks = {}) {
    const userId = String(botUserId);
    if (this._clients.has(userId)) {
      try { await this._clients.get(userId).disconnect(); } catch (_) {}
    }
    const device = getDeviceProfile();
    const client = new TdSessionClient({
      apiId: this.apiId,
      apiHash: this.apiHash,
      proxy: getProxyConfig(),
      deviceProfile: device,
      botUserId: userId,
    });
    try {
      await client.connect();
      // TDlib 首次需登录（授权状态会走到 WaitPhoneNumber / WaitCode）；
      // 已登录（本地已存 session）则直接 Ready。这里 attempt 登录补全：
      // 若走到等待手机号，说明该账号尚未在 TDlib 侧建立 session，跳过（等登录流程）。
      this._clients.set(userId, client);
      logger.info(`[SESSION][TDlib] 用户 ${userId} TDlib 已创建${client.authState ? " (" + client.authState["@type"] + ")" : ""}`);
      if (hooks.onConnected) {
        await hooks.onConnected(userId, client);
      }
      return client;
    } catch (error) {
      logger.error(`[SESSION][TDlib] 用户 ${userId} 连接失败: ${error.message}`);
      accountDao.updateStatus(userId, "ERROR", error.message);
      const enabledRules = ruleDao.listEnabledByUser(userId);
      for (const rule of enabledRules) {
        ruleDao.update(rule.id, { enabled: 0 });
      }
      if (enabledRules.length > 0) {
        logger.warn(`[SESSION][TDlib] 用户 ${userId} 的 ${enabledRules.length} 条规则已自动停用（Session 失效）`);
      }
      try { await client.disconnect(); } catch (_) {}
      if (hooks.onFailed) { await hooks.onFailed(userId, error); }
      throw error;
    }
  }
  async adoptClient(botUserId, client, hooks = {}) {
    const userId = String(botUserId);
    const old = this._clients.get(userId);
    if (old && old !== client) {
      try { await old.disconnect(); } catch (_) {}
      this._clients.delete(userId);
    }
    try {
      this._clients.set(userId, client);
      logger.info(`[SESSION][TDlib] 用户 ${userId} TDlib 已收编`);
      if (hooks.onConnected) { await hooks.onConnected(userId, client); }
      return client;
    } catch (error) {
      logger.error(`[SESSION][TDlib] 用户 ${userId} 收编失败: ${error.message}`);
      throw error;
    }
  }
  async destroyClient(botUserId) {
    const userId = String(botUserId);
    const client = this._clients.get(userId);
    if (client) {
      try { await client.disconnect(); } catch (error) {
        logger.warn(`[SESSION][TDlib] 用户 ${userId} 断开连接异常: ${error.message}`);
      }
      this._clients.delete(userId);
      logger.info(`[SESSION][TDlib] 用户 ${userId} TDlib 已销毁`);
    }
  }
  async loadActiveSessions(hooks = {}) {
    const accounts = accountDao.getAllForRecovery();
    if (accounts.length === 0) {
      logger.info("[SESSION][TDlib] 没有需要恢复的 Session");
      return;
    }
    logger.info(`[SESSION][TDlib] 开始恢复 ${accounts.length} 个 Session`);
    let successCount = 0;
    let failCount = 0;
    for (const account of accounts) {
      try {
        await this.initClient(account.bot_user_id, account.session_string, hooks);
        successCount++;
      } catch (error) {
        failCount++;
        logger.error(`[SESSION][TDlib] 恢复失败: ${account.bot_user_id} (${maskPhone(account.phone)}) \u2192 ${error.message}`);
      }
    }
    logger.info(`[SESSION][TDlib] Session 恢复完成: 成功 ${successCount}, 失败 ${failCount}`);
  }
  getActiveCount() { return this._clients.size; }
  getAllClients() { return Array.from(this._clients.entries()); }
  async destroyAll() {
    const userIds = Array.from(this._clients.keys());
    for (const userId of userIds) {
      await this.destroyClient(userId);
    }
    logger.info("[SESSION][TDlib] 所有 TDlib 已销毁");
  }
}
module.exports = SessionManager;
