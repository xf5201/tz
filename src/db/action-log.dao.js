// src/db/action-log.dao.js
const { getConnection } = require('./connection');

/**
 * action_logs 表 DAO（动作执行记录）
 *
 * 状态：CREATED | SENT | FAILED | DRY_RUN
 */
const actionLogDao = {
  /**
   * 新建动作记录
   * @param {object} data
   * @returns {number} id
   */
  insert(data) {
    const db = getConnection();
    const info = db.prepare(`
      INSERT INTO action_logs (bot_user_id, rule_id, chat_id, direction, bet_amount, action_text, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(data.bot_user_id),
      data.rule_id ?? null,
      String(data.chat_id),
      data.direction,
      data.bet_amount,
      data.action_text,
      data.status || 'CREATED'
    );
    return info.lastInsertRowid;
  },

  /**
   * 标记已发送
   */
  markSent(id, actionText = null) {
    const db = getConnection();
    if (actionText != null) {
      db.prepare("UPDATE action_logs SET status = 'SENT', action_text = ? WHERE id = ?").run(actionText, id);
    } else {
      db.prepare("UPDATE action_logs SET status = 'SENT' WHERE id = ?").run(id);
    }
  },

  /**
   * 标记失败
   */
  markFailed(id, errorMsg, retryCount = 0) {
    const db = getConnection();
    db.prepare(`
      UPDATE action_logs
      SET status = 'FAILED', error_msg = ?, retry_count = ?
      WHERE id = ?
    `).run(String(errorMsg).slice(0, 500), retryCount, id);
  },

  /**
   * 用户动作记录（分页）
   */
  listByUser(botUserId, { limit = 20, offset = 0 } = {}) {
    const db = getConnection();
    return db.prepare(`
      SELECT a.*, r.name AS rule_name
      FROM action_logs a
      LEFT JOIN rules r ON r.id = a.rule_id
      WHERE a.bot_user_id = ?
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ? OFFSET ?
    `).all(String(botUserId), limit, offset);
  },

  countByUser(botUserId, since = null) {
    const db = getConnection();
    if (since) {
      return db.prepare(`
        SELECT COUNT(*) AS n FROM action_logs
        WHERE bot_user_id = ? AND created_at >= ?
      `).get(String(botUserId), since).n;
    }
    return db.prepare('SELECT COUNT(*) AS n FROM action_logs WHERE bot_user_id = ?')
      .get(String(botUserId)).n;
  },

  /**
   * 分状态统计（报表）
   * @returns {{SENT: number, FAILED: number, DRY_RUN: number, CREATED: number}}
   */
  countByStatus(botUserId, since = null) {
    const db = getConnection();
    const rows = since
      ? db.prepare(`
          SELECT status, COUNT(*) AS n FROM action_logs
          WHERE bot_user_id = ? AND created_at >= ?
          GROUP BY status
        `).all(String(botUserId), since)
      : db.prepare(`
          SELECT status, COUNT(*) AS n FROM action_logs
          WHERE bot_user_id = ?
          GROUP BY status
        `).all(String(botUserId));
    const result = { SENT: 0, FAILED: 0, DRY_RUN: 0, CREATED: 0 };
    for (const row of rows) result[row.status] = row.n;
    return result;
  },

  /**
   * 最近失败记录（面板告警展示）
   */
  latestFailed(botUserId) {
    const db = getConnection();
    return db.prepare(`
      SELECT * FROM action_logs
      WHERE bot_user_id = ? AND status = 'FAILED'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(String(botUserId));
  },

  /**
   * 取规则在某群最新一条未结算的实发下注（status=SENT 且未写 settled_at）
   */
  getLatestUnsettledSent(ruleId, chatId) {
    const db = getConnection();
    return db.prepare(`
      SELECT * FROM action_logs
      WHERE rule_id = ? AND chat_id = ? AND status = 'SENT' AND settled_at IS NULL
      ORDER BY id DESC LIMIT 1
    `).get(ruleId, String(chatId));
  },

  /**
   * 取规则在某群最新一条未结算的模拟下注（DRY_RUN，用于按开奖点数模拟判定输赢）
   */
  getLatestUnsettledDry(ruleId, chatId) {
    const db = getConnection();
    return db.prepare(`
      SELECT * FROM action_logs
      WHERE rule_id = ? AND chat_id = ? AND status = 'DRY_RUN' AND settled_at IS NULL
      ORDER BY id DESC LIMIT 1
    `).get(ruleId, String(chatId));
  },

  /**
   * 写入结算结果（幂等：仅当未结算时生效）
   * @param {number} id
   * @param {0|1} isWin
   * @param {number|null} profit - 赢为正、输为负；模拟注传 null
   * @returns {number} 实际更新的行数（0=已被并发结算）
   */
  markSettled(id, isWin, profit) {
    const db = getConnection();
    return db.prepare(`
      UPDATE action_logs
      SET is_win = ?, profit = ?, settled_at = datetime('now', '+8 hours')
      WHERE id = ? AND settled_at IS NULL
    `).run(isWin, profit ?? null, id).changes;
  },

  /**
   * 盈亏合计（今日/累计）
   * @param {string} botUserId
   * @param {string|null} since - 'YYYY-MM-DD HH:mm:ss' 起始时间，null 为全部
   * @returns {number}
   */
  sumProfit(botUserId, since = null) {
    const db = getConnection();
    const row = since
      ? db.prepare(`
          SELECT SUM(profit) AS s FROM action_logs
          WHERE bot_user_id = ? AND profit IS NOT NULL AND settled_at >= ?
        `).get(String(botUserId), since)
      : db.prepare(`
          SELECT SUM(profit) AS s FROM action_logs
          WHERE bot_user_id = ? AND profit IS NOT NULL
        `).get(String(botUserId));
    return row?.s ? Number(row.s) : 0;
  },

  /**
   * 定时清理
   */
  purgeBefore(cutoff) {
    const db = getConnection();
    return db.prepare('DELETE FROM action_logs WHERE created_at < ?').run(cutoff).changes;
  },

  /**
   * 删除用户全部动作记录（删除账号）
   */
  deleteByUser(botUserId) {
    const db = getConnection();
    db.prepare('DELETE FROM action_logs WHERE bot_user_id = ?').run(String(botUserId));
  },
};

module.exports = actionLogDao;
