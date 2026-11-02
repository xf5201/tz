// src/core/profit.guard.js

/**
 * 止盈守卫（纯计算，无 IO）
 *
 * 两个「盈利」概念必须分开，不能混：
 *
 *   todayProfit  今日总盈利 = 今日全部已结算注的盈亏合计
 *                由 action_logs 实打实累计，跨零点归零，任何"清零"操作都不动它
 *   roundProfit  本轮盈利   = 今日总盈利 − 基准（profit_baseline）
 *                仅用于止盈判定；用户点「恢复运行」时把基准拉到当前的今日总盈利，
 *                本轮盈利随之归零，今日总盈利分毫不动
 *
 * 这样既满足「达到目标就停、必须手动恢复」，又满足「恢复时清掉的是本轮盈利，
 * 而不是今天真正赚到的钱」。
 */

/**
 * 北京时区当天日期（与 SQLite datetime('now','+8 hours') 对齐）
 * @param {number} nowMs - 时间戳（便于测试注入）
 * @returns {string} 'YYYY-MM-DD'
 */
function beijingDate(nowMs = Date.now()) {
  const shifted = new Date(nowMs + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * 本轮盈利 = 今日总盈利 − 基准
 *
 * @param {number} todayProfit - 今日总盈利
 * @param {number|null} baseline - 本轮起点（null 视为 0）
 * @returns {number}
 */
function calcRoundProfit(todayProfit, baseline) {
  const t = Number(todayProfit) || 0;
  const b = Number(baseline) || 0;
  return Math.round((t - b) * 100) / 100;
}

/**
 * 是否已达到止盈目标
 *
 * 只认「盈利」达标：本轮盈利为负或为 0 一律不触发（亏钱时不该停）。
 * 目标为 null / 非正数 → 视为未启用，永不触发。
 *
 * @param {number} roundProfit - 本轮盈利
 * @param {number|null|undefined} takeProfit - 止盈目标
 * @returns {boolean}
 */
function isTakeProfitReached(roundProfit, takeProfit) {
  if (takeProfit == null) return false;
  const target = Number(takeProfit);
  if (!Number.isFinite(target) || target <= 0) return false;

  const rp = Number(roundProfit) || 0;
  return rp >= target;
}

/**
 * 基准是否已跨天（跨天则本轮盈利应重新从 0 起算）
 *
 * @param {string|null} baselineDate - 基准记录的日期
 * @param {number} nowMs
 * @returns {boolean}
 */
function isBaselineStale(baselineDate, nowMs = Date.now()) {
  if (!baselineDate) return true;
  return baselineDate !== beijingDate(nowMs);
}

module.exports = {
  beijingDate,
  calcRoundProfit,
  isTakeProfitReached,
  isBaselineStale,
};
