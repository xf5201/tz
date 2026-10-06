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
  updateState(ruleId, chatId, {
    consecutiveLosses, armedDirection, pendingDirection, streakBroken,
  } = {}) {
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
    if (streakBroken !== undefined) {
      sets.push('streak_broken = ?');
      values.push(streakBroken ? 1 : 0);
    }
    if (!sets.length) return;
    sets.push("updated_at = datetime('now', '+8 hours')");
    values.push(ruleId, String(chatId));
    db.prepare(`
      UPDATE rule_chat_state SET ${sets.join(', ')} WHERE rule_id = ? AND chat_id = ?
    `).run(...values);
  },

  /**
   * 停掉某条规则在某个群的下注（连败 / 止损达到上限时调用）
   *
   * 与「停用整条规则」的区别：规则本身继续在其他群运行，
   * 仅本群不再判定、不再下注；连败清零、待发/挂起清空。
   *
   * @param {number} ruleId
   * @param {string} chatId
   * @param {string} reason - 停用原因（面板展示 / 通知文案）
   */
  blockChat(ruleId, chatId, reason) {
    const db = getConnection();
    db.prepare(`
      UPDATE rule_chat_state
      SET blocked = 1,
          blocked_reason = ?,
          blocked_at = datetime('now', '+8 hours'),
          consecutive_losses = 0,
          armed_direction = NULL,
          pending_direction = NULL,
          streak_broken = 0,
          updated_at = datetime('now', '+8 hours')
      WHERE rule_id = ? AND chat_id = ?
    `).run(String(reason || '').slice(0, 200), ruleId, String(chatId));
  },

  /**
   * 解除某个群的停注（下一次触发自动恢复 / 人工恢复）
   *
   * 恢复时连败必须清零，否则一进来就按倍投金额下注。
   *
   * @param {number} ruleId
   * @param {string} chatId
   * @returns {boolean} 是否真的解除了
   */
  unblockChat(ruleId, chatId) {
    const db = getConnection();
    const info = db.prepare(`
      UPDATE rule_chat_state
      SET blocked = 0,
          blocked_reason = NULL,
          blocked_at = NULL,
          consecutive_losses = 0,
          streak_broken = 0,
          armed_direction = NULL,
          updated_at = datetime('now', '+8 hours')
      WHERE rule_id = ? AND chat_id = ? AND blocked = 1
    `).run(ruleId, String(chatId));
    return info.changes > 0;
  },

  /**
   * 清掉某用户全部「待发」标记（保留挂起，挂起的注还要等结算）
   *
   * 用于止盈停止 / 余额耗尽等全局停止：待发不会被消费，与其等 3 分钟
   * 超时自愈，不如立刻清掉，恢复运行时从干净状态开始。
   *
   * @param {string} botUserId
   * @returns {number} 清理的行数
   */
  clearArmedByUser(botUserId) {
    const db = getConnection();
    return db.prepare(`
      UPDATE rule_chat_state
      SET armed_direction = NULL, updated_at = datetime('now', '+8 hours')
      WHERE armed_direction IS NOT NULL
        AND rule_id IN (SELECT id FROM rules WHERE bot_user_id = ?)
    `).run(String(botUserId)).changes;
  },

  /**
   * 用户全部被停注的「规则 × 群」（面板展示 / 人工恢复）
   *
   * @param {string} botUserId
   * @returns {Array} 含 rule_id / chat_id / blocked_reason / blocked_at / rule_name
   */
  listBlockedByUser(botUserId) {
    const db = getConnection();
    return db.prepare(`
      SELECT s.rule_id, s.chat_id, s.blocked_reason, s.blocked_at,
             r.name AS rule_name, r.bot_user_id
      FROM rule_chat_state s
      JOIN rules r ON r.id = s.rule_id
      WHERE r.bot_user_id = ? AND s.blocked = 1
      ORDER BY s.blocked_at DESC
    `).all(String(botUserId));
  },

  /**
   * 解除某用户的全部停注群（人工一键恢复）
   * @param {string} botUserId
   * @returns {number} 恢复的群数
   */
  unblockAllByUser(botUserId) {
    const db = getConnection();
    return db.prepare(`
      UPDATE rule_chat_state
      SET blocked = 0,
          blocked_reason = NULL,
          blocked_at = NULL,
          consecutive_losses = 0,
          streak_broken = 0,
          armed_direction = NULL,
          updated_at = datetime('now', '+8 hours')
      WHERE blocked = 1 AND rule_id IN (
        SELECT id FROM rules WHERE bot_user_id = ?
      )
    `).run(String(botUserId)).changes;
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
          blocked = 0, blocked_reason = NULL, blocked_at = NULL, streak_broken = 0,
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
