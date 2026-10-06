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
   * 清理「待发超时」的状态（自愈用）
   *
   * 场景：连击满足后进入 armed，等待群里出现「底注」开盘信号才真正下注。
   * 若开盘信号迟迟不来（群改版 / 关键词变了 / 该期已封盘 / 进程重启错过信号），
   * armed 会永久停留，而策略执行器遇到 armed 就直接 continue，
   * 导致该「规则 × 群」再也不会判定、不会下注、不会结算 —— 静默卡死。
   *
   * @param {number} ruleId
   * @param {string} chatId
   * @param {number} ttlMs - 待发最长保留时间（毫秒）
   * @returns {boolean} 是否真的清掉了
   */
  clearStaleArmed(ruleId, chatId, ttlMs) {
    const db = getConnection();
    const seconds = Math.max(1, Math.round(Number(ttlMs || 0) / 1000));
    const info = db.prepare(`
      UPDATE rule_chat_state
      SET armed_direction = NULL,
          updated_at = datetime('now', '+8 hours')
      WHERE rule_id = ? AND chat_id = ?
        AND armed_direction IS NOT NULL
        AND pending_direction IS NULL
        AND updated_at < datetime('now', '+8 hours', ?)
    `).run(ruleId, String(chatId), `-${seconds} seconds`);
    return info.changes > 0;
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

  /**
   * 挂起超时的「规则 × 群」列表（巡检兜底用）
   *
   * 场景：结算消息丢失（轮询窗口跳过 / 群消息改版）时，pending 永久停留，
   * 该「规则 × 群」不再判定、不再下注 —— 静默卡死。
   * 附带最近一条未结算实发注的创建时间，供告警信息与人工对账。
   *
   * @param {number} ttlSeconds - 挂起最长保留时间（秒）
   * @returns {Array} 含 bot_user_id / rule_name / last_unsettled_at
   */
  listStalePending(ttlSeconds) {
    const db = getConnection();
    return db.prepare(`
      SELECT s.rule_id, s.chat_id, s.pending_direction, s.updated_at,
             r.bot_user_id, r.name AS rule_name,
             (SELECT MAX(a.created_at) FROM action_logs a
              WHERE a.rule_id = s.rule_id AND a.chat_id = s.chat_id
                AND a.status = 'SENT' AND a.settled_at IS NULL) AS last_unsettled_at
      FROM rule_chat_state s
      JOIN rules r ON r.id = s.rule_id
      WHERE s.pending_direction IS NOT NULL
        AND s.updated_at < datetime('now', '+8 hours', ?)
    `).all(`-${Math.max(1, ttlSeconds)} seconds`);
  },
};

module.exports = ruleStateDao;
