// src/db/message-log.dao.js
const { getConnection } = require('./connection');

/**
 * message_logs 表 DAO（开奖流水）
 *
 * UNIQUE(chat_id, msg_id) 提供数据库层兜底去重；
 * 连击历史（连续 N 次大/小/单/双）也从本表读取。
 */
const messageLogDao = {
  /**
   * 写入开奖流水（幂等：重复消息忽略）
   * @param {object} data
   * @returns {boolean} 是否为新消息
   */
  insert(data) {
    const db = getConnection();
    const info = db.prepare(`
      INSERT OR IGNORE INTO message_logs (bot_user_id, chat_id, msg_id, sender_id, msg_type, value, raw_text)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.bot_user_id ? String(data.bot_user_id) : null,
      String(data.chat_id),
      String(data.msg_id),
      data.sender_id ? String(data.sender_id) : null,
      data.msg_type || null,
      data.value ?? null,
      data.raw_text || null
    );
    return info.changes > 0;
  },

  /**
   * 指定群最近 N 条开奖点数（新→旧），供连击判定
   * @param {string} chatId
   * @param {number} n
   * @returns {number[]}
   */
  recentValues(chatId, n) {
    const db = getConnection();
    const rows = db.prepare(`
      SELECT value FROM message_logs
      WHERE chat_id = ? AND value IS NOT NULL
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(String(chatId), n);
    return rows.map((r) => r.value);
  },

  /**
   * 用户流水查询（分页）
   */
  listByUser(botUserId, { chatId = null, limit = 20, offset = 0 } = {}) {
    const db = getConnection();
    const where = chatId
      ? 'WHERE bot_user_id = ? AND chat_id = ?'
      : 'WHERE bot_user_id = ?';
    const params = chatId ? [String(botUserId), String(chatId)] : [String(botUserId)];
    return db.prepare(`
      SELECT * FROM message_logs ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
  },

  countByUser(botUserId, since = null) {
    const db = getConnection();
    if (since) {
      return db.prepare(`
        SELECT COUNT(*) AS n FROM message_logs
        WHERE bot_user_id = ? AND created_at >= ?
      `).get(String(botUserId), since).n;
    }
    return db.prepare('SELECT COUNT(*) AS n FROM message_logs WHERE bot_user_id = ?')
      .get(String(botUserId)).n;
  },

  /**
   * 近 N 分钟消息吞吐（面板展示）
   */
  countRecent(botUserId, minutes = 10) {
    const db = getConnection();
    return db.prepare(`
      SELECT COUNT(*) AS n FROM message_logs
      WHERE bot_user_id = ? AND created_at >= datetime('now', '+8 hours', ?)
    `).get(String(botUserId), `-${minutes} minutes`).n;
  },

  /**
   * 定时清理：删除保留期之前的流水
   * @returns {number} 删除条数
   */
  purgeBefore(cutoff) {
    const db = getConnection();
    return db.prepare('DELETE FROM message_logs WHERE created_at < ?').run(cutoff).changes;
  },

  /**
   * 删除用户全部流水（删除账号）
   */
  deleteByUser(botUserId) {
    const db = getConnection();
    db.prepare('DELETE FROM message_logs WHERE bot_user_id = ?').run(String(botUserId));
  },
};

module.exports = messageLogDao;
