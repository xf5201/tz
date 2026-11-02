// src/utils/mask.util.js

/**
 * 脱敏工具
 *
 * 禁止记录：
 *   - 完整手机号（必须脱敏）
 *   - Session 字符串
 *   - Bot Token
 *   - API Hash / API ID 组合
 *   - 2FA 密码
 *   - 用户发来的验证码原文
 */

/**
 * 手机号脱敏
 * 规则：保留前 3 位 + 后 4 位，中间用 **** 替换
 *
 * 示例：
 *   +8613812341234 → +86138****1234
 *   13812341234    → 138****1234
 *
 * @param {string} phone - 手机号
 * @returns {string} 脱敏后的手机号
 */
function maskPhone(phone) {
  if (!phone) return '';
  const s = String(phone);
  if (s.length <= 7) return s.slice(0, 3) + '****';
  return s.slice(0, 3) + '****' + s.slice(-4);
}

/**
 * 群 ID 脱敏（日志中只保留尾号）
 * @param {string} chatId
 * @returns {string}
 */
function maskChatId(chatId) {
  if (!chatId) return '';
  const s = String(chatId);
  return s.length <= 6 ? s : `***${s.slice(-6)}`;
}

module.exports = {
  maskPhone,
  maskChatId,
};
