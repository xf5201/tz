// src/utils/format.util.js

/**
 * 日期格式化
 * @param {Date} date
 * @param {string} format - YYYY MM DD HH mm ss
 * @returns {string}
 */
function formatDate(date, format = 'YYYY-MM-DD HH:mm:ss') {
  const pad = (n) => String(n).padStart(2, '0');
  return format
    .replace('YYYY', String(date.getFullYear()))
    .replace('MM', pad(date.getMonth() + 1))
    .replace('DD', pad(date.getDate()))
    .replace('HH', pad(date.getHours()))
    .replace('mm', pad(date.getMinutes()))
    .replace('ss', pad(date.getSeconds()));
}

/**
 * SQLite datetime('now') 字符串 → 本地格式
 * @param {string|null} dbTime
 * @returns {string}
 */
function formatDbTime(dbTime) {
  if (!dbTime) return '-';
  const d = new Date(dbTime.replace(' ', 'T') + '+08:00');
  if (isNaN(d.getTime())) return dbTime;
  return formatDate(d);
}

/**
 * 金额格式化（整数金额）
 * @param {number} amount
 * @returns {string}
 */
function formatAmount(amount) {
  if (amount == null || isNaN(Number(amount))) return '-';
  return String(Math.round(Number(amount)));
}

/**
 * 数字格式化（带千分位，最多保留 2 位小数）—— 余额等金额展示
 * @param {number|string|null} n
 * @returns {string}
 */
function formatNumber(n) {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return '-';
  const num = Number(n);
  const str = Math.abs(num % 1) > 0 ? num.toFixed(2) : String(Math.round(num));
  return str.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 群名简写：取前 n 个字符（按 Unicode 码点切，emoji 不会被切成半个）
 *
 * 下注记录一行要塞时间/方向/金额/输赢，群名只能给很短的位置，
 * 故只取前 3 个字，例如「可乐聊胜群」→「可乐聊」。
 *
 * @param {string|null} title
 * @param {number} n - 保留字符数（默认 3）
 * @returns {string} 空值返回空串
 */
function shortTitle(title, n = 3) {
  if (!title) return '';
  const chars = Array.from(String(title).trim());
  return chars.slice(0, n).join('');
}

/**
 * 截断字符串
 * @param {string} str
 * @param {number} maxLength
 * @param {string} suffix
 * @returns {string}
 */
function truncate(str, maxLength, suffix = '...') {
  if (!str) return '';
  return str.length > maxLength ? str.slice(0, maxLength) + suffix : str;
}

/**
 * HTML 转义（面板文本使用 parse_mode: 'HTML'）
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = {
  formatDate,
  formatDbTime,
  formatAmount,
  formatNumber,
  shortTitle,
  truncate,
  escapeHtml,
};
