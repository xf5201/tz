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

module.exports = accountDao;
