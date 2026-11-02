// src/db/bot-user.dao.js
const { getConnection } = require('./connection');

/**
 * bot_users 表 DAO
 *
 * 接口：
 *   getById / upsert / setAllowed / updateRole / getAllAllowed / delete
 */
const botUserDao = {
  /**
   * 根据 bot_user_id 查询
   * @param {string} botUserId
   * @returns {object|undefined}
   */
  getById(botUserId) {
    const db = getConnection();
    return db.prepare('SELECT * FROM bot_users WHERE bot_user_id = ?').get(String(botUserId));
  },

  /**
   * 创建或更新用户（upsert）
   * @param {object} data - { bot_user_id, username, first_name }
   */
  upsert(data) {
    const db = getConnection();
    db.prepare(`
      INSERT INTO bot_users (bot_user_id, username, first_name)
      VALUES (?, ?, ?)
      ON CONFLICT(bot_user_id) DO UPDATE SET
        username = COALESCE(excluded.username, bot_users.username),
        first_name = COALESCE(excluded.first_name, bot_users.first_name)
    `).run(String(data.bot_user_id), data.username || null, data.first_name || null);
  },

  /**
   * 白名单开关
   * @param {string} botUserId
   * @param {0|1} isAllowed
   */
  setAllowed(botUserId, isAllowed) {
    const db = getConnection();
    db.prepare('UPDATE bot_users SET is_allowed = ? WHERE bot_user_id = ?')
      .run(isAllowed, String(botUserId));
  },

  /**
   * 角色更新
   * @param {string} botUserId
   * @param {string} role - 'USER' | 'ADMIN'
   */
  updateRole(botUserId, role) {
    const db = getConnection();
    db.prepare('UPDATE bot_users SET role = ? WHERE bot_user_id = ?')
      .run(role, String(botUserId));
  },

  /**
   * 所有白名单用户
   * @returns {Array}
   */
  getAllAllowed() {
    const db = getConnection();
    return db.prepare('SELECT * FROM bot_users WHERE is_allowed = 1').all();
  },

  /**
   * 删除用户记录
   * @param {string} botUserId
   */
  delete(botUserId) {
    const db = getConnection();
    db.prepare('DELETE FROM bot_users WHERE bot_user_id = ?').run(String(botUserId));
  },
};

module.exports = botUserDao;
