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
  // 带 caption 的媒体消息（动画/图片/视频/文档等）：开盘信号常用 GIF+底注文字，
  // caption 是 formattedText 对象（{text, entities}），旧代码只认 messageText 导致文本恒空。
  if (!message && c) {
    const cap = c.caption;
    if (cap) {
      if (typeof cap === "string") {
        message = cap;
      } else if (Array.isArray(cap)) {
        for (const item of cap) {
          const t = item && item.text ? (item.text.text || item.text) : (item || "");
          if (t) { message += t; }
        }
      } else if (cap.text) {
        message = (cap.text.text || cap.text) || "";
      }
    }
  }
  return {
    id: tdMsg.id,
    chatId,
    senderId,
    message,
    reply: replyToMsgId,
    // 机器人回复我们＝艾特我们（textEntityTypeMentionName 实体，user_id 即账号 id）。
    // 余额播报归属用它最可靠：天然唯一、不受 reply_to id 对不上的影响（实测 1092068467）
    mentionUserIds: extractMentionUserIds(tdMsg),
    _td: tdMsg,
    _type: "tlib",
  };
}

/**
 * 从 TDlib message 提取「艾特」实体的账号 id 列表。
 * 机器人对下注人的回复会用 textEntityTypeMentionName 艾特对应的人，
 * 实体里带 user_id；余额归属以它为准（比 reply_to / 昵称都硬）。
 */
function extractMentionUserIds(tdMsg) {
  const out = [];
  try {
    if (!tdMsg || !tdMsg.content) return out;
    // 普通文本的 entities
    const textEnts = (tdMsg.content.text && tdMsg.content.text.entities) || [];
    // 带 caption 的媒体（动画/图片）里的 entities
    const captionEnts = (tdMsg.content.caption && tdMsg.content.caption.entities) || [];
    for (const e of [...textEnts, ...captionEnts]) {
      if (e && e.type && e.type["@type"] === "textEntityTypeMentionName" && e.type.user_id) {
        const uid = String(e.type.user_id);
        if (!out.includes(uid)) out.push(uid);
      }
    }
  } catch (_) { /* 提取失败不阻塞 */ }
  return out;
}

class TdSessionClient {
  constructor(config) {
    this.config = config;
    this._client = null;
    this.authState = null;
    this._eventHandlers = [];
    this._authWaiters = [];
    this._stateWaiters = [];
    // 已加载过的 chat_id（TDlib 语义：getChatHistory 前 chat 必须先加载）
    this._loadedChats = new Set();
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
   * 将 marked 格式群 ID 转回 TDlib 内部 chat_id。
   * 兼容两种输入：
   *   1. TDlib 原生负 id：-100xxxxxxxxx / -xxxxxxxxx（getDialogs 新格式、监听推送）→ 原样返回
   *   2. 库里旧 bug 存的双负号：-100-100xxxxxxxxx（getDialogs 拼错时代保存的）→ 剥掉一层 -100
   * 旧实现见 s.startsWith("-100") 就 slice(4)，会把单负号 -100xxx 错切成正数 xxx，导致 Chat not found。
   */
  _toTdlibChatId(chatId) {
    const s = String(chatId || "").trim();
    if (s.startsWith("-100-")) return Number(s.slice(4)); // 双负号 → 剥成 -100xxx
    return Number(s); // 单负号 / 正数原样
  }
  /**
   * 确保 chat 已加载：getChatHistory 前 TDlib 要求 chat 已在内存（否则 400 Chat not found）。
   * 实测：先 getChats 全量加载后再操作必成功；这里用 set 缓存避免每次全量拉取。
   */
  async _ensureChatLoaded(chatId) {
    const key = String(chatId);
    if (this._loadedChats.has(key)) return;
    const r = await this._client.send({ "@type": "getChat", chat_id: chatId, timeoutMs: 8000 }).catch(() => null);
    if (r && r["@type"] !== "error" && r.id != null) {
      this._loadedChats.add(key);
      return;
    }
    // 单查未加载 → 全量拉一次（TDlib 建立所有 chat 缓存）
    const cr = await this._client.send({
      "@type": "getChats",
      chat_list: { "@type": "chatListMain" },
      limit: 200,
      timeoutMs: 15000,
    }).catch(() => null);
    if (cr && Array.isArray(cr.chat_ids)) {
      for (const cid of cr.chat_ids) this._loadedChats.add(String(cid));
    }
    this._loadedChats.add(key);
  }
  async getMessages(chatId, opts) {
    opts = opts || {};
    const limit = opts.limit || 30;
    const tid = this._toTdlibChatId(chatId);
    // TDlib 语义：getChatHistory 前必须先加载 chat（getChat/getChats），否则 400 Chat not found
    await this._ensureChatLoaded(tid);
    const res = await this._client.send({ "@type": "getChatHistory", chat_id: tid, from_message_id: 0, offset: 0, limit, only_local: false, timeoutMs: 20000 });
    if (res && res["@type"] === "error") throw new Error(res.code + ": " + res.message);
    return (res.messages || []).map(toGramjsMessage).filter(Boolean);
  }
  /**
   * 发送文本消息（TDlib 版，兼容 GramJS sendMessage 调用：client.sendMessage(chatId, { message })）
   * 返回 TDlib message 对象（含 id），与 GramJS 返回结构兼容。
   *
   * 注意：TDlib sendMessage 返回的 id 是「本地乐观 id」，服务端最终 id 不同步；
   * 余额播报靠 reply_to 匹配我们下注消息的真实 id，id 对不上会导致余额被过滤。
   * 因此发送成功后拉最新历史，找自己发的、文本匹配的消息，取服务端真实 id 返回。
   */
  async sendMessage(chatId, params = {}) {
    const text = String(params.message != null ? params.message : (params.text != null ? params.text : ""));
    const tid = this._toTdlibChatId(chatId);
    await this._ensureChatLoaded(tid);
    const res = await this._client.send({
      "@type": "sendMessage",
      chat_id: tid,
      input_message_content: {
        "@type": "inputMessageText",
        text: { "@type": "formattedText", text, entities: [] },
        disable_web_page_preview: true,
        clear_draft: false,
      },
      timeoutMs: 20000,
    });
    if (res && res["@type"] === "error") throw new Error(res.code + ": " + res.message);
    // 校正真实 id：拉最新历史，找自己发出、文本归一化后完全一致的那条消息
    const norm = text.replace(/\s+/g, '');
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 600));
      try {
        const hist = await this._client.send({
          "@type": "getChatHistory", chat_id: tid, from_message_id: 0, offset: 0,
          limit: 10, only_local: false, timeoutMs: 12000,
        });
        if (hist && hist["@type"] !== "error" && Array.isArray(hist.messages)) {
          const mine = hist.messages.find((m) => {
            if (!m.is_outgoing) return false;
            const c = m.content;
            if (!c || c["@type"] !== "messageText" || !c.text) return false;
            return String(c.text.text || "").replace(/\s+/g, '') === norm;
          });
          if (mine) return mine;
        }
      } catch (_) { /* 重试 */ }
    }
    return res; // 兜底：返回原始对象（至少不阻塞下注）
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
          // TDlib 的 chat_id 本身就是负数（-groupId），即 GramJS marked 格式（-xxx）
          markedId = String(id);
        } else if (t && t["@type"] === "chatTypeSupergroup") {
          isGroup = true;
          isChannel = !!t.is_channel;
          // TDlib 超级群 chat_id 本身就是 -100xxxxxxxxxx（负数+前缀），
          // 直接 String 即 GramJS marked 格式；不能再拼 "-100"+id 否则会成 -100-100xxx
          markedId = String(id);
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
