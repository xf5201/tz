// src/services/tdlib.client.js
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");

const TDJSON_LIB =
  process.env.TDLIB_LIB_PATH ||
  (fs.existsSync(path.join(__dirname, "..", "..", "vendor", "tdlib", "libtdjson.so")) &&
    path.join(__dirname, "..", "..", "vendor", "tdlib", "libtdjson.so"));
if (!fs.existsSync(TDJSON_LIB)) {
  throw new Error("TDlib 动态库不存在: " + TDJSON_LIB);
}
const koffi = require("koffi");
const lib = koffi.load(TDJSON_LIB);
const cCreate = lib.func("void *td_json_client_create()");
const cDestroy = lib.func("void td_json_client_destroy(void *)");
const cSend = lib.func("void td_json_client_send(void *, const char *)");
const cReceive = lib.func("const char *td_json_client_receive(void *, double)");

class TdlClient {
  constructor() {
    this._requestSeq = 0;
    this._pending = new Map();
    this._updateHandlers = new Map();
    this._closed = false;
    this.events = new EventEmitter();
    this._raw = cCreate();
    if (!this._raw) throw new Error("td_json_client_create 返回空指针");
    this._startReceiveLoop();
  }
  _startReceiveLoop() {
    this._pollTimer = setInterval(() => { try { this._receiveOnce(); } catch (_) {} }, 1);
    if (this._pollTimer.unref) this._pollTimer.unref();
  }
  _receiveOnce() {
    if (this._closed) return;
    const buf = cReceive(this._raw, 0.02);
    if (!buf) return;
    // koffi 对 `const char *` 返回类型：3.3.8 直接转成 JS string；
    // 旧版本可能返回指针对象（需 readCString）。两种都兼容。
    let str = null;
    if (typeof buf === "string") {
      str = buf;
    } else if (buf && typeof buf.readCString === "function") {
      str = buf.readCString();
    }
    if (!str) return;
    let obj;
    try { obj = JSON.parse(str); } catch (_) { return; }
    const extra = obj["@extra"];
    if (extra && this._pending.has(extra)) {
      const p = this._pending.get(extra);
      this._pending.delete(extra);
      clearTimeout(p.timer);
      if (obj["@type"] === "error") p.reject(new Error(obj.code + ": " + obj.message));
      else p.resolve(obj);
      return;
    }
    if (obj["@type"] && obj["@type"].startsWith("update")) {
      this.events.emit("update", obj);
      const h = this._updateHandlers.get(obj["@type"]);
      if (h) h(obj);
    }
  }
  async send(obj) {
    if (this._closed) throw new Error("TDlib 客户端已关闭");
    const extra = String(++this._requestSeq);
    const payload = Object.assign({}, obj, { "@extra": extra });
    cSend(this._raw, JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._pending.delete(extra); reject(new Error("TDlib 请求超时: " + payload["@type"])); }, (obj.timeoutMs || 30000));
      this._pending.set(extra, { resolve, reject, timer });
    });
  }
  onUpdate(type, handler) { this._updateHandlers.set(type, handler); }
  close() {
    this._closed = true;
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._raw) { try { cDestroy(this._raw); } catch (_) {} this._raw = null; }
  }
}
module.exports = { TdlClient, TDJSON_LIB };
