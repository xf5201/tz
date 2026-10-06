// src/db/account.dao.js
const { getConnection } = require('./connection');

/**
 * accounts 表 DAO
 *
 * 状态：PENDING_SETUP | ACTIVE | ERROR | LOGGED_OUT | DELETED
 *
 * 规则：
 *   - 所有查询带 bot_user_id
 *   - 关键写操作使用事务（由 service 层调用 transaction）
 */

const accountDao = {
  /**
   * 获取用户的有效账号（非 DELETED）
   * @param {string} botUserId
   * @returns {object|undefined}
   */
  getActive(botUserId) {
    const db = getConnection();
    return db.prepare(`
      SELECT * FROM accounts
      WHERE bot_user_id = ? AND status != 'DELETED'
    `).get(String(botUserId));
  },

  /**
   * 插入新账号
   * @param {object} data
   */
  insert(data) {
    const db = getConnection();
    db.prepare(`
      INSERT INTO accounts (bot_user_id, phone, session_string, status)
      VALUES (?, ?, ?, ?)
    `).run(
      String(data.bot_user_id),
      data.phone,
      data.session_string,
      data.status || 'PENDING_SETUP'
    );
  },

  /**
   * 更新 Session（重新登录时）
   * @param {string} botUserId
   * @param {string} sessionString
   */
  updateSession(botUserId, sessionString) {
    const db = getConnection();
    db.prepare(`
      UPDATE accounts
      SET session_string = ?, status = 'PENDING_SETUP', last_error = NULL,
          updated_at = datetime('now', '+8 hours')
      WHERE bot_user_id = ?
    `).run(sessionString, String(botUserId));
  },

  /**
   * 更新监听开关（不触碰登录态）
   * @param {string} botUserId
   * @param {0|1} enabled
   */
  setListenEnabled(botUserId, enabled) {
    const db = getConnection();
    db.prepare(`
      UPDATE accounts SET listen_enabled = ?, updated_at = datetime('now', '+8 hours')
      WHERE bot_user_id = ?
    `).run(enabled, String(botUserId));
  },

  /**
   * 更新账号状态
   * @param {string} botUserId
   * @param {string} status - PENDING_SETUP | ACTIVE | ERROR | LOGGED_OUT | DELETED
   * @param {string|null} lastError
   */
  updateStatus(botUserId, status, lastError = null) {
    const db = getConnection();
    db.prepare(`
      UPDATE accounts
      SET status = ?, last_error = ?, updated_at = datetime('now', '+8 hours')
      WHERE bot_user_id = ?
    `).run(status, lastError, String(botUserId));
  },

  /**
   * 物理删除账号
   * @param {string} botUserId
   */
  deleteByUser(botUserId) {
    const db = getConnection();
    db.prepare('DELETE FROM accounts WHERE bot_user_id = ?').run(String(botUserId));
  },

  /**
   * 写入当前余额（由机器人对本账号下注的回复消息解析得到）
   *
   * 首次写入时把该余额自动记为「初始余额」（亏损基准），
   * 之后不再变动，除非用户在面板手动重置基准。
   *
   * @param {string} botUserId
   * @param {number} balance
   */
  updateBalance(botUserId, balance) {
    const db = getConnection();
    db.prepare(`
      UPDATE accounts
      SET balance = ?,
          balance_updated_at = datetime('now', '+8 hours'),
          initial_balance = COALESCE(initial_balance, ?)
      WHERE bot_user_id = ?
    `).run(balance, balance, String(botUserId));
  },

  /**
   * 重置亏损基准（把当前余额设为初始余额）
   *
   * @param {string} botUserId
   * @param {number} balance - 新的基准值（通常传当前余额）
   */
  setInitialBalance(botUserId, balance) {
    const db = getConnection();
    db.prepare(`
      UPDATE accounts
      SET initial_balance = ?, alert_notified_at = NULL,
          updated_at = datetime('now', '+8 hours')
      WHERE bot_user_id = ?
    `).run(balance, String(botUserId));
  },

  /**
   * 亏损预警开关
   * @param {string} botUserId
   * @param {0|1} enabled
   */
  setAlertEnabled(botUserId, enabled) {
    const db = getConnection();
    db.prepare(`
      UPDATE accounts
      SET alert_enabled = ?, alert_notified_at = NULL,
          updated_at = datetime('now', '+8 hours')
      WHERE bot_user_id = ?
    `).run(enabled ? 1 : 0, String(botUserId));
  },

  /**
   * 记录本次告警时间（防重复刷屏）
   * @param {string} botUserId
   */
  markAlertNotified(botUserId) {
    const db = getConnection();
    db.prepare(`
      UPDATE accounts
      SET alert_notified_at = datetime('now', '+8 hours')
      WHERE bot_user_id = ?
    `).run(String(botUserId));
  },

  /**
   * 清除告警标记（余额回到阈值以上时调用，允许下次回落再次告警）
   * @param {string} botUserId
   */
  clearAlertNotified(botUserId) {
    const db = getConnection();
    db.prepare('UPDATE accounts SET alert_notified_at = NULL WHERE bot_user_id = ?')
      .run(String(botUserId));
  },

  /**
   * 设置今日止盈目标（本轮盈利达到即停止；传 null 关闭）
   *
   * 首次设置时把「当时的今日盈利」记为基准，本轮盈利从 0 开始算。
   *
   * @param {string} botUserId
   * @param {number|null} target - 止盈目标金额；null = 不启用
   * @param {number} baseline - 当前的今日盈利（作为本轮起点）
   */
  setTakeProfit(botUserId, target, baseline = 0) {
    const db = getConnection();
    db.prepare(`
      UPDATE accounts
      SET take_profit = ?,
          profit_baseline = COALESCE(profit_baseline, ?),
          profit_baseline_date = COALESCE(profit_baseline_date, ?),
          updated_at = datetime('now', '+8 hours')
      WHERE bot_user_id = ?
    `).run(
      target ?? null,
      baseline,
      beijingDate(),
      String(botUserId)
    );
  },

  /**
   * 因达到止盈目标而停止
   * @param {string} botUserId
   */
  markProfitStopped(botUserId) {
    const db = getConnection();
    db.prepare(`
      UPDATE accounts
      SET profit_stopped = 1, profit_stopped_at = datetime('now', '+8 hours'),
          updated_at = datetime('now', '+8 hours')
      WHERE bot_user_id = ?
    `).run(String(botUserId));
  },

  /**
   * 恢复运行（达到止盈后由用户手动触发）
   *
   * 关键：只把「本轮盈利」清零（基准拉到当前今日盈利），
   * 今日总盈利本身是一条条下注记录算出来的，完全不受影响。
   *
   * @param {string} botUserId
   * @param {number} baseline - 当前的今日盈利（作为新的本轮起点）
   */
  resumeFromProfitStop(botUserId, baseline = 0) {
    const db = getConnection();
    db.prepare(`
      UPDATE accounts
      SET profit_stopped = 0,
          profit_stopped_at = NULL,
          profit_baseline = ?,
          profit_baseline_date = ?,
          updated_at = datetime('now', '+8 hours')
      WHERE bot_user_id = ?
    `).run(baseline, beijingDate(), String(botUserId));
  },

  /**
   * 跨天重置基准（新的一天，本轮盈利重新从 0 起算）
   *
   * @param {string} botUserId
   */
  resetProfitBaseline(botUserId) {
    const db = getConnection();
    db.prepare(`
      UPDATE accounts
      SET profit_baseline = 0,
          profit_baseline_date = ?,
          profit_stopped = 0,
          profit_stopped_at = NULL,
          updated_at = datetime('now', '+8 hours')
      WHERE bot_user_id = ?
    `).run(beijingDate(), String(botUserId));
  },

  /**
   * 获取所有需要恢复 Session 的账号（启动流程）
   * @returns {Array}
   */
  getAllForRecovery() {
    const db = getConnection();
    return db.prepare(`
      SELECT * FROM accounts
      WHERE status IN ('PENDING_SETUP', 'ACTIVE')
    `).all();
  },

  /**
   * 获取所有 ACTIVE 账号
   * @returns {Array}
   */
  getAllActive() {
    const db = getConnection();
    return db.prepare("SELECT * FROM accounts WHERE status = 'ACTIVE'").all();
  },
};

/**
 * 北京时区当天日期（与 SQLite datetime('now','+8 hours') 对齐）
 * @returns {string} 'YYYY-MM-DD'
 */
function beijingDate() {
  const shifted = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

module.exports = accountDao;
