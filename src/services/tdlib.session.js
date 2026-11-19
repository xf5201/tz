const path = require("path");
const { TdlClient } = require("./tdlib.client");

function toGramjsMessage(tdMsg) {
  if (!tdMsg || tdMsg["@type"] !== "message") return null;
  const chatId = String(tdMsg.chat_id);
  const sid = tdMsg.sender_id;
  const senderId = sid ? String(sid.user_id || sid.chat_id || "") : null;
  let replyToMsgId = null;
  if (tdMsg.reply_to && tdMsg.reply_to.message_id) replyToMsgId = String(tdMsg.reply_to.message_id);
  let message = "";
  const c = tdMsg.content;
  if (c && c.message_text && c.message_text.text && c.message_text.text.text) message = c.message_text.text.text;
  else if (c && c.text && c.text.text) message = c.text.text;
  else if (typeof c === "string") message = c;
  return { id: tdMsg.id, chatId, senderId, message, reply: replyToMsgId, _td: tdMsg, _type: "tlib" };
}

class TdSessionClient {
  constructor(config) {
    this.config = config;
    this._client = null;
    this.authState = null;
    this._eventHandlers = [];
    this._authWaiters = [];
    this._stateWaiters = [];
  }
  get raw() { return this._client; }
  async connect() {
    if (this._client) return this;
    this._client = new TdlClient();
    this._wireUpdates();
    await this._initAuth();
    return this;
  }
  _wireUpdates() {
    this._client.onUpdate("updateAuthorizationState", (u) => {
      const prevType = this.authState ? this.authState["@type"] : null;
      this.authState = u.authorization_state;
      if (u.authorization_state["@type"] === "authorizationStateReady") this._notifyReady();
      // 状态真正变化时唤醒 waitForState 等待者（登录流程用）
      if (prevType !== u.authorization_state["@type"] && this._stateWaiters && this._stateWaiters.length) {
        const ws = this._stateWaiters;
        this._stateWaiters = [];
        for (const w of ws) { try { w(this.authState); } catch (_) {} }
      }
    });
    this._client.events.on("update", (u) => {
      if (u["@type"] === "updateNewMessage" || u["@type"] === "updateNewChannelMessage") {
        const m = toGramjsMessage(u.message);
        if (m) { for (const h of this._eventHandlers) { try { h({ message: m }); } catch (_) {} } }
      }
    });
  }
  async _initAuth() {
    const device = this.config.deviceProfile || {};
    const params = {
      "@type": "setTdlibParameters",
      use_test_dc: false,
      database_directory: path.join("/root/tmp", "tdlib", "db", String(this.config.botUserId || "default")),
      files_directory: path.join("/root/tmp", "tdlib", "files"),
      use_message_database: false,
      use_secret_chats: false,
      api_id: Number(this.config.apiId),
      api_hash: this.config.apiHash,
      system_language_code: device.langCode || "zh",
      device_model: device.deviceModel || "Redmi 23078RKD5C",
      system_version: device.systemVersion || "SDK 36",
      application_version: device.appVersion || "12.10.1",
      enable_storage_optimizer: true,
      ignore_file_names: true,
    };
    const proxy = this.config.proxy;
    if (proxy) { params.parameters = [{ "@type": "proxySocks5", server: proxy.ip || "127.0.0.1", port: Number(proxy.port || 7890), username: proxy.username || "", password: proxy.password || "" }]; }
    await this._client.send(params);
    // setDatabaseEncryptionKey 只能在数据库首次初始化（authorizationStateWaitEncryptionKey）时调用一次；
    // 若库已存在（无论是否已登录），重复调用会返回 401 Unauthorized，导致整个会话初始化失败。
    // 因此：等待初始授权状态，仅当是 WaitEncryptionKey 时才设置空加密密钥。
    const initState = await this.waitForState(
      ["authorizationStateWaitEncryptionKey", "authorizationStateWaitPhoneNumber", "authorizationStateWaitPassword", "authorizationStateReady", "authorizationStateClosed", "authorizationStateWaitOtherDeviceConfirmation"],
      15000
    );
    if (initState && initState["@type"] === "authorizationStateWaitEncryptionKey") {
      await this._client.send({ "@type": "setDatabaseEncryptionKey", new_encryption_key: "" });
      // 设置密钥后等它进入下一步（等手机号 / 已就绪）
      await this.waitForState(["authorizationStateWaitPhoneNumber", "authorizationStateWaitPassword", "authorizationStateReady", "authorizationStateWaitOtherDeviceConfirmation"], 15000);
    }
    return this;
  }
  _notifyReady() { for (const w of this._authWaiters) { w(); } this._authWaiters = []; }
  async waitForState(targetTypes, timeoutMs) {
    targetTypes = Array.isArray(targetTypes) ? targetTypes : [targetTypes];
    timeoutMs = timeoutMs || 45000;
    if (this.authState && targetTypes.includes(this.authState["@type"])) return this.authState;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this._stateWaiters = this._stateWaiters.filter((w) => w._t !== t); reject(new Error(`等待 TDlib 授权状态超时: ${targetTypes.join("/")}`)); }, timeoutMs);
      const waiter = (_s) => { clearTimeout(t); resolve(_s); };
      waiter._t = t;
      this._stateWaiters.push(waiter);
    });
  }
  async waitReady(timeoutMs) {
    timeoutMs = timeoutMs || 30000;
    if (this.authState && this.authState["@type"] === "authorizationStateReady") return this;
    if (this.authState && this.authState["@type"] === "authorizationStateClosed") throw new Error("authorizationStateClosed");
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("等待 TDlib 授权超时")), timeoutMs);
      this._authWaiters.push(() => { clearTimeout(t); resolve(this); });
    });
  }
  async getMe() {
    const res = await this._client.send({ "@type": "getMe", timeoutMs: 15000 });
    return { id: res.id, username: res.username, name: ((res.first_name || "") + " " + (res.last_name || "")).trim() };
  }
  /**
   * 将 marked 格式群 ID（-100xxx / -xxx，库里存储格式）转回 TDlib 内部 chat_id
   */
  _toTdlibChatId(chatId) {
    const s = String(chatId || "").trim();
    if (s.startsWith("-100")) return Number(s.slice(4));
    if (s.startsWith("-")) return Number(s.slice(1));
    return Number(s);
  }
  async getMessages(chatId, opts) {
    opts = opts || {};
    const limit = opts.limit || 30;
    const res = await this._client.send({ "@type": "getChatHistory", chat_id: this._toTdlibChatId(chatId), from_message_id: 0, offset: 0, limit, only_local: false, timeoutMs: 20000 });
    if (res && res["@type"] === "error") throw new Error(res.code + ": " + res.message);
    return (res.messages || []).map(toGramjsMessage).filter(Boolean);
  }
  /**
   * 发送文本消息（TDlib 版，兼容 GramJS sendMessage 调用：client.sendMessage(chatId, { message })）
   * 返回 TDlib message 对象（含 id），与 GramJS 返回结构兼容。
   */
  async sendMessage(chatId, params = {}) {
    const text = String(params.message != null ? params.message : (params.text != null ? params.text : ""));
    const res = await this._client.send({
      "@type": "sendMessage",
      chat_id: this._toTdlibChatId(chatId),
      input_message_content: {
        "@type": "inputMessageText",
        text: { "@type": "formattedText", text, entities: [] },
        disable_web_page_preview: true,
        clear_draft: false,
      },
      timeoutMs: 20000,
    });
    if (res && res["@type"] === "error") throw new Error(res.code + ": " + res.message);
    return res; // message 对象含 id
  }
  /**
   * 拉取对话列表（TDlib 版，兼容 GramJS getDialogs 返回结构）
   */
  async getDialogs(opts = {}) {
    opts = opts || {};
    const limit = opts.limit || 200;
    const res = await this._client.send({
      "@type": "getChats",
      chat_list: { "@type": "chatListMain" },
      limit,
      timeoutMs: 20000,
    });
    if (res && res["@type"] === "error") throw new Error(res.code + ": " + res.message);
    const ids = (res && res.chat_ids) || [];
    const out = [];
    for (const id of ids) {
      try {
        const chat = await this._client.send({ "@type": "getChat", chat_id: id, timeoutMs: 10000 });
        if (!chat || chat["@type"] === "error") continue;
        const t = chat.type;
        let isGroup = false;
        let isChannel = false;
        let markedId = null;
        if (t && t["@type"] === "chatTypeBasicGroup") {
          isGroup = true;
          markedId = "-" + id;
        } else if (t && t["@type"] === "chatTypeSupergroup") {
          isGroup = true;
          isChannel = !!t.is_channel;
          markedId = "-100" + id;
        } else {
          continue; // 私有/密聊不看
        }
        const title = chat.title || "(未命名)";
        out.push({
          id: markedId,
          markedId,
          title,
          name: title,
          isGroup,
          isChannel,
          entity: { id: markedId },
        });
      } catch (_) { /* 单群失败跳过 */ }
    }
    return out;
  }
  async login(phone) {
    const res = await this._client.send({ "@type": "setAuthenticationPhoneNumber", phone_number: phone });
    if (res["@type"] === "error") throw new Error(res.code + ": " + res.message);
    return { requiresCode: true };
  }
  async checkAuthenticationCode(code) { return this._client.send({ "@type": "checkAuthenticationCode", code: String(code) }); }
  async checkAuthenticationPassword(password) { return this._client.send({ "@type": "checkAuthenticationPassword", password: String(password) }); }
  loadDatabaseSession() { return this; }
  async disconnect() {
    if (this._client) { try { await this._client.send({ "@type": "close" }); } catch (_) {} this._client.close(); this._client = null; }
  }
  addEventHandler(handler, ev) { this._eventHandlers.push(handler); }
}
module.exports = { TdSessionClient, toGramjsMessage };
