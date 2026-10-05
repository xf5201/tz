// src/services/account.service.js
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { computeCheck } = require('telegram/Password');

const accountDao = require('../db/account.dao');
const monitoredChatDao = require('../db/monitored-chat.dao');
const ruleDao = require('../db/rule.dao');
const messageLogDao = require('../db/message-log.dao');
const actionLogDao = require('../db/action-log.dao');
const operationLogDao = require('../db/operation-log.dao');
const panelContextDao = require('../db/panel-context.dao');
const botUserDao = require('../db/bot-user.dao');
const { transaction } = require('../db/connection');
const { maskPhone } = require('../utils/mask.util');
const logger = require('../utils/logger');

// 动态判断代理
function getProxyConfig() {
  if (!process.env.http_proxy && !process.env.HTTP_PROXY) {
    return null; // 没开代理，直连
  }
  return {
    ip: '127.0.0.1',
    port: 7890,
    socksType: 5,
    timeout: 10000,
  };
}

/**
 * 账号服务：登录（验证码 + 2FA）/ 登出 / 删除账号 / 监听群管理
 *
 * 登录临时上下文存内存 Map（phoneCodeHash 阶段尚无 userId 落库问题），
 * 登录成功后 Session 明文存 SQLite（与 pc28 一致，本机文件库）。
 */
class AccountService {
  /**
   * @param {object} sessionManager
   * @param {object} config - { apiId, apiHash }
   * @param {object} hooks - { onConnected(botUserId, client) } 登录成功后由 listener 注册
   */
  constructor(sessionManager, config, hooks = {}) {
    this.sessionManager = sessionManager;
    this.apiId = config.apiId;
    this.apiHash = config.apiHash;
    this.hooks = hooks;
    this._tempClients = new Map(); // botUserId → { client, phone, phoneCodeHash }

    this._clientOptions = {
      connectionRetries: 3,
      deviceModel: 'Android',
      systemVersion: '13',
      appVersion: '10.15.0',
      langCode: 'zh',
    };
  }

  /**
   * 发起登录：下发验证码
   * @param {string} botUserId
   * @param {string} phone
   */
  async initiateLogin(botUserId, phone) {
    logger.info(`[ACCOUNT] 用户 ${botUserId} 发起登录: ${maskPhone(phone)}`);

    if (this._tempClients.has(botUserId)) {
      try { await this._tempClients.get(botUserId).client.disconnect(); } catch (_) {}
      this._tempClients.delete(botUserId);
    }

    const session = new StringSession('');
    const proxy = getProxyConfig();

    const client = new TelegramClient(session, this.apiId, this.apiHash, {
      ...this._clientOptions,
      ...(proxy ? { proxy } : {}),
    });

    await client.connect();

    const result = await client.sendCode(
      {
        apiId: this.apiId,
        apiHash: this.apiHash,
        deviceModel: this._clientOptions.deviceModel,
        systemVersion: this._clientOptions.systemVersion,
        appVersion: this._clientOptions.appVersion,
        langCode: this._clientOptions.langCode,
      },
      phone
    );

    this._tempClients.set(botUserId, {
      client,
      phone,
      phoneCodeHash: result.phoneCodeHash,
    });

    logger.info(`[ACCOUNT] 用户 ${botUserId} 验证码已发送`);
  }

  /**
   * 提交验证码
   * @returns {{ need2FA?: boolean, phone: string }}
   */
  async submitCode(botUserId, code) {
    const temp = this._tempClients.get(botUserId);
    if (!temp) throw new Error('登录会话已过期，请重新开始');

    const { client, phone, phoneCodeHash } = temp;
    logger.info(`[ACCOUNT] 用户 ${botUserId} 提交验证码`);

    const formattedCode = String(code).replace(/\s+/g, '').split('').join(' ');

    try {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash,
          phoneCode: formattedCode,
        })
      );
      return await this._finalizeLogin(botUserId, client, phone);
    } catch (error) {
      if (error.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        logger.info(`[ACCOUNT] 用户 ${botUserId} 需要 2FA 验证`);
        return { need2FA: true, phone };
      }
      if (error.errorMessage === 'PHONE_CODE_INVALID') {
        throw new Error('验证码错误');
      }
      if (error.errorMessage === 'PHONE_CODE_EXPIRED') {
        throw new Error('验证码已过期，请重新开始登录');
      }
      if (error.errorMessage && error.errorMessage.startsWith('FLOOD_WAIT_')) {
        const seconds = error.errorMessage.match(/FLOOD_WAIT_(\d+)/)?.[1] ?? '60';
        throw new Error(`操作过于频繁，请 ${seconds} 秒后重试`);
      }
      throw error;
    }
  }

  /**
   * 提交 2FA 密码（SRP 校验）
   */
  async submit2FA(botUserId, password) {
    const temp = this._tempClients.get(botUserId);
    if (!temp) throw new Error('登录会话已过期，请重新开始');

    const { client, phone } = temp;
    logger.info(`[ACCOUNT] 用户 ${botUserId} 提交 2FA`);

    try {
      const passwordInfo = await client.invoke(new Api.account.GetPassword());
      const passwordSrp = await computeCheck(passwordInfo, password);

      await client.invoke(
        new Api.auth.CheckPassword({ password: passwordSrp })
      );

      return await this._finalizeLogin(botUserId, client, phone);
    } catch (error) {
      if (error.errorMessage === 'PASSWORD_HASH_INVALID') {
        throw new Error('2FA 密码错误');
      }
      if (error.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        try { await client.disconnect(); } catch (_) {}
        this._tempClients.delete(botUserId);
        throw new Error('2FA 会话已失效，请重新开始登录流程');
      }
      throw error;
    }
  }

  /**
   * 登录收尾：Session 落库 + 收编 Client + 启动监听
   *
   * 安全约束：仅允许登录 Bot 对话所属的本人账号
   * （登录返回的 TG 用户 ID 必须与 bot_user_id 一致，防止用他人凭证监听）。
   */
  async _finalizeLogin(botUserId, client, phone) {
    const me = await client.getMe();
    const signedUserId = String(me.id);

    if (signedUserId !== String(botUserId)) {
      // 非本人账号：立即断开并放弃本次登录
      try { await client.disconnect(); } catch (_) {}
      this._tempClients.delete(botUserId);
      logger.warn(`[ACCOUNT] 用户 ${botUserId} 试图登录他人账号 ${signedUserId}，已拒绝`);
      throw new Error('为保护账号安全，仅支持登录与当前机器人对话相同的本人账号');
    }

    const sessionString = client.session.save();

    try { await client.disconnect(); } catch (_) {}
    this._tempClients.delete(botUserId);

    transaction(() => {
      const existing = accountDao.getActive(botUserId);
      if (existing) {
        accountDao.updateSession(botUserId, sessionString);
      } else {
        accountDao.insert({
          bot_user_id: botUserId,
          phone,
          session_string: sessionString,
          status: 'PENDING_SETUP',
        });
      }
      operationLogDao.insert({
        bot_user_id: botUserId,
        action: 'LOGIN',
        detail: `登录成功: ${maskPhone(phone)}`,
      });
    });

    await this.sessionManager.initClient(botUserId, sessionString, {
      onConnected: this.hooks.onConnected,
    });
    logger.info(`[ACCOUNT] 用户 ${botUserId} 登录完成: ${maskPhone(phone)}`);
    return { need2FA: false, phone };
  }

  /**
   * 退出登录：断开连接、停止监听，保留 Session 与历史数据
   */
  async logout(botUserId) {
    const account = accountDao.getActive(botUserId);
    if (!account) throw new Error('尚未登录账号');

    await this.sessionManager.destroyClient(botUserId);
    accountDao.updateStatus(botUserId, 'LOGGED_OUT');

    operationLogDao.insert({
      bot_user_id: botUserId,
      action: 'LOGOUT',
      detail: '退出登录（数据保留）',
    });
    logger.info(`[ACCOUNT] 用户 ${botUserId} 已退出登录（数据保留）`);
  }

  /**
   * 删除账号：服务端登出 + 本级数据全部清除（事务包裹，不可恢复）
   */
  async deleteAccount(botUserId) {
    logger.info(`[ACCOUNT] 用户 ${botUserId} 开始删除账号`);

    await this.sessionManager.destroyClient(botUserId);

    transaction(() => {
      messageLogDao.deleteByUser(botUserId);   // 先删流水
      actionLogDao.deleteByUser(botUserId);    // 再删动作记录（解除外键引用）
      ruleDao.deleteByUser(botUserId);
      monitoredChatDao.deleteByUser(botUserId);
      operationLogDao.deleteByUser(botUserId);
      accountDao.deleteByUser(botUserId);
      panelContextDao.delete(botUserId);
    });

    logger.info(`[ACCOUNT] 用户 ${botUserId} 账号已删除`);
  }

  /**
   * 保存监听群（多群全量替换），账号 status → ACTIVE
   * @param {string} botUserId
   * @param {Array<{chat_id: string, chat_title: string|null, chat_type: string|null}>} chats
   * @returns {number} 保存数量
   */
  saveMonitoredChats(botUserId, chats) {
    const account = accountDao.getActive(botUserId);
    if (!account) throw new Error('请先登录账号');

    let count = 0;
    transaction(() => {
      count = monitoredChatDao.replaceAll(botUserId, chats);
      if (count > 0 && account.status !== 'ACTIVE') {
        accountDao.updateStatus(botUserId, 'ACTIVE');
      }
      operationLogDao.insert({
        bot_user_id: botUserId,
        action: 'UPDATE_MONITORED_CHATS',
        detail: `监听群 ${count} 个: ${chats.map((c) => c.chat_title || c.chat_id).join('、')}`,
      });
    });

    logger.info(`[ACCOUNT] 用户 ${botUserId} 监听群已更新: ${count} 个`);
    return count;
  }

  /**
   * 监听开关（不触碰登录态）
   */
  setListenEnabled(botUserId, enabled) {
    const account = accountDao.getActive(botUserId);
    if (!account) throw new Error('请先登录账号');
    accountDao.setListenEnabled(botUserId, enabled ? 1 : 0);
    operationLogDao.insert({
      bot_user_id: botUserId,
      action: enabled ? 'LISTEN_ON' : 'LISTEN_OFF',
      detail: null,
    });
  }

  getAccount(botUserId) {
    return accountDao.getActive(botUserId);
  }
}

module.exports = AccountService;
