// src/db/monitored-chat.dao.js
const { getConnection } = require('./connection');

/**
 * monitored_chats 表 DAO（多群监听配置）
 *
 * 接口：
 *   listByUser / get / replaceAll / add / removeByChat / countByUser / deleteByUser
 */
const monitoredChatDao = {
  /**
   * 用户已勾选的全部监听群
   * @param {string} botUserId
   * @returns {Array}
   */
  listByUser(botUserId) {
    const db = getConnection();
    return db.prepare(`
      SELECT * FROM monitored_chats
      WHERE bot_user_id = ?
      ORDER BY created_at DESC
    `).all(String(botUserId));
  },

  /**
   * 单个监听群
   */
  get(botUserId, chatId) {
    const db = getConnection();
    return db.prepare(`
      SELECT * FROM monitored_chats
      WHERE bot_user_id = ? AND chat_id = ?
    `).get(String(botUserId), String(chatId));
  },

  /**
   * 全量替换监听群（确认勾选时调用，事务内执行）
   * @param {string} botUserId
   * @param {Array<{chat_id: string, chat_title: string|null, chat_type: string|null}>} chats
   */
  replaceAll(botUserId, chats) {
    const db = getConnection();
    db.prepare('DELETE FROM monitored_chats WHERE bot_user_id = ?').run(String(botUserId));
    const insert = db.prepare(`
      INSERT OR IGNORE INTO monitored_chats (bot_user_id, chat_id, chat_title, chat_type)
      VALUES (?, ?, ?, ?)
    `);
    for (const c of chats) {
      insert.run(String(botUserId), String(c.chat_id), c.chat_title || null, c.chat_type || null);
    }
    return chats.length;
  },

  /**
   * 监听某群的全部「ACTIVE 且开启监听」账号（消息分发目标）
   * @param {string} chatId
   * @returns {string[]} bot_user_id 列表
   */
  listActiveUsersByChat(chatId) {
    const db = getConnection();
    return db.prepare(`
      SELECT DISTINCT mc.bot_user_id
      FROM monitored_chats mc
      JOIN accounts a ON a.bot_user_id = mc.bot_user_id
      WHERE mc.chat_id = ? AND a.status = 'ACTIVE' AND a.listen_enabled = 1
    `).all(String(chatId)).map((r) => r.bot_user_id);
  },

  /**
   * 用户监听群数量
   * @param {string} botUserId
   * @returns {number}
   */
  countByUser(botUserId) {
    const db = getConnection();
    return db.prepare('SELECT COUNT(*) AS n FROM monitored_chats WHERE bot_user_id = ?')
      .get(String(botUserId)).n;
  },

  /**
   * 删除用户全部监听群
   * @param {string} botUserId
   */
  deleteByUser(botUserId) {
    const db = getConnection();
    db.prepare('DELETE FROM monitored_chats WHERE bot_user_id = ?').run(String(botUserId));
  },
};

module.exports = monitoredChatDao;
