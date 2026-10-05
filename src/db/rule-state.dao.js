// src/db/rule-state.dao.js
const { getConnection } = require('./connection');

/**
 * rule_chat_state 表 DAO（规则 × 群 的连败与下注状态）
 *
 * 同一条规则作用于全部监听群，每个群独立计数、独立流转：
 *   armed_direction    待发方向：连击已满足，等待「底注」开局消息
 *   pending_direction  挂起方向：已发送下注，等待下一条开奖结算
 */
const ruleStateDao = {
  /**
   * 取规则在某群的状态（无则创建默认行）
   */
  ensure(ruleId, chatId) {
    const db = getConnection();
    db.prepare(`
      INSERT OR IGNORE INTO rule_chat_state (rule_id, chat_id)
      VALUES (?, ?)
    `).run(ruleId, String(chatId));
    return db.prepare(`
      SELECT * FROM rule_chat_state
      WHERE rule_id = ? AND chat_id = ?
    `).get(ruleId, String(chatId));
  },

  /**
   * 更新状态（连败数 / 待发方向 / 挂起方向，传 undefined 表示保持不变）
   */
  updateState(ruleId, chatId, { consecutiveLosses, armedDirection, pendingDirection } = {}) {
    const db = getConnection();
    const sets = [];
    const values = [];
    if (consecutiveLosses !== undefined) {
      sets.push('consecutive_losses = ?');
      values.push(consecutiveLosses);
    }
    if (armedDirection !== undefined) {
      sets.push('armed_direction = ?');
      values.push(armedDirection ?? null);
    }
    if (pendingDirection !== undefined) {
      sets.push('pending_direction = ?');
      values.push(pendingDirection ?? null);
    }
    if (!sets.length) return;
    sets.push("updated_at = datetime('now', '+8 hours')");
    values.push(ruleId, String(chatId));
    db.prepare(`
      UPDATE rule_chat_state SET ${sets.join(', ')} WHERE rule_id = ? AND chat_id = ?
    `).run(...values);
  },

  /**
   * 重置规则全部群的状态（规则配置变更 / 人工启用）
   */
  resetByRule(ruleId) {
    const db = getConnection();
    db.prepare(`
      UPDATE rule_chat_state
      SET consecutive_losses = 0, armed_direction = NULL, pending_direction = NULL,
          updated_at = datetime('now', '+8 hours')
      WHERE rule_id = ?
    `).run(ruleId);
  },

  /**
   * 规则的全部群状态（报表展示）
   */
  listByRule(ruleId) {
    const db = getConnection();
    return db.prepare('SELECT * FROM rule_chat_state WHERE rule_id = ?').all(ruleId);
  },

  /**
   * 用户全部规则状态（启动恢复日志 / 报表汇总）
   */
  listByUser(botUserId) {
    const db = getConnection();
    return db.prepare(`
      SELECT s.* FROM rule_chat_state s
      JOIN rules r ON r.id = s.rule_id
      WHERE r.bot_user_id = ?
    `).all(String(botUserId));
  },

  /**
   * 全局挂起下注笔数（启动恢复日志）
   */
  countPending() {
    const db = getConnection();
    return db.prepare(
      'SELECT COUNT(*) AS n FROM rule_chat_state WHERE pending_direction IS NOT NULL'
    ).get().n;
  },
};

module.exports = ruleStateDao;
