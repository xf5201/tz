// src/utils/device-profile.js
/**
 * 统一的 TG 客户端设备指纹（登录 & 运行时重连共用）。
 *
 * 背景（GramJS Issue #452，社区大量复现）：
 *   不传 deviceModel / systemVersion / appVersion 时，GramJS 默认向 Telegram
 *   上报 "Unknown" 设备，风控判定为可疑客户端，表现为登录或挂机后
 *   10~20 秒内该 session 的所有设备会话被吊销（AUTH_KEY_UNREGISTERED）。
 *
 *   本项目的踩坑路径：登录时走 account.service（带设备信息），
 *   但 PM2 重启后由 session.manager 重建连接（不带设备信息 → Unknown），
 *   同一 session 的设备指纹反复跳变，最终被吊销。
 *
 * 约束：
 *   1. 所有 new TelegramClient 的地方必须展开本配置；
 *   2. 同一 session 的指纹应保持稳定，运行期间不要频繁变更。
 *
 * 可通过 .env 覆盖：
 *   TG_DEVICE_MODEL / TG_SYSTEM_VERSION / TG_APP_VERSION / TG_LANG_CODE
 */
function getDeviceProfile() {
  return {
    // 以下为真实设备指纹（来源：用户本机 Redmi K60 Ultra / Android 16 / 官方 TG 12.10.1）
    deviceModel: process.env.TG_DEVICE_MODEL || 'Redmi 23078RKD5C',
    systemVersion: process.env.TG_SYSTEM_VERSION || 'SDK 36',
    appVersion: process.env.TG_APP_VERSION || '12.10.1',
    langCode: process.env.TG_LANG_CODE || 'zh',
  };
}

module.exports = { getDeviceProfile };
