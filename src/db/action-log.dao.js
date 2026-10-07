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
      INSERT INTO action_logs (bot_user_id, rule_id, chat_id, direction, bet_amount, action_text, status, round_period)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(data.bot_user_id),
      data.rule_id ?? null,
      String(data.chat_id),
      data.direction,
      data.bet_amount,
      data.action_text,
      data.status || 'CREATED',
      data.round_period ?? null
    );
    return info.lastInsertRowid;
  },

  /**
   * 按 ID 取动作记录
   * @param {number} id
   * @returns {object|undefined}
   */
  getById(id) {
    const db = getConnection();
    return db.prepare('SELECT * FROM action_logs WHERE id = ?').get(id);
  },

  /**
   * 回写注单所属期号（下注成功播报里带期号，用于修正/补全）
   * 仅在原本为空时写入，不覆盖已有值（下注时的开盘期号优先）
   * @param {number} id
   * @param {string} period
   * @returns {number}
   */
  updateRoundPeriodIfEmpty(id, period) {
    const db = getConnection();
    return db.prepare(`
      UPDATE action_logs SET round_period = ? WHERE id = ? AND round_period IS NULL
    `).run(String(period), id).changes;
  },

  /**
   * 标记已发送
   *
   * @param {number} id
   * @param {string|null} actionText
   * @param {string|number|null} betMsgId - 该笔下注消息在群里的 msg_id
   *   （机器人的余额回复是对这条消息的回复，靠它把余额归属到本账号）
   */
  markSent(id, actionText = null, betMsgId = null) {
    const db = getConnection();
    if (betMsgId != null) {
      db.prepare(`
        UPDATE action_logs
        SET status = 'SENT', bet_msg_id = ?${actionText != null ? ', action_text = ?' : ''}
        WHERE id = ?
      `).run(...(actionText != null
        ? [String(betMsgId), actionText, id]
        : [String(betMsgId), id]));
      return;
    }
    if (actionText != null) {
      db.prepare("UPDATE action_logs SET status = 'SENT', action_text = ? WHERE id = ?").run(actionText, id);
    } else {
      db.prepare("UPDATE action_logs SET status = 'SENT' WHERE id = ?").run(id);
    }
  },

  /**
   * 按下注消息 ID 反查归属账号（余额回复归属判定）
   *
   * @param {string} chatId
   * @param {string|number} msgId - 被回复的消息 ID
   * @returns {object|undefined} 含 bot_user_id
   */
  getByBetMsgId(chatId, msgId) {
    const db = getConnection();
    if (msgId == null) return undefined;
    return db.prepare(`
      SELECT * FROM action_logs
      WHERE chat_id = ? AND bet_msg_id = ?
      ORDER BY id DESC LIMIT 1
    `).get(String(chatId), String(msgId));
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
    // 带出群名（下注记录要显示「在哪个群下的」）：
    // 群被取消勾选后 monitored_chats 里就没了，故用 LEFT JOIN + 回退到 ID 尾号
    return db.prepare(`
      SELECT a.*, r.name AS rule_name, mc.chat_title
      FROM action_logs a
      LEFT JOIN rules r ON r.id = a.rule_id
      LEFT JOIN monitored_chats mc
        ON mc.bot_user_id = a.bot_user_id AND mc.chat_id = a.chat_id
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
   * 规则在某群近期是否有 CREATED（发送在途）动作
   *
   * 用途：结算消息到达时若下注仍在发送中（状态还是 CREATED，尚未转 SENT），
   * 不能把挂起清掉——否则发送完成后这笔注永远等不到结算（漏结算）。
   * @param {number} ruleId
   * @param {string} chatId
   * @param {number} seconds - 视为「在途」的时间窗口
   * @returns {object|undefined}
   */
  getRecentCreated(ruleId, chatId, seconds) {
    const db = getConnection();
    return db.prepare(`
      SELECT * FROM action_logs
      WHERE rule_id = ? AND chat_id = ? AND status = 'CREATED'
        AND created_at >= datetime('now', '+8 hours', ?)
      ORDER BY id DESC LIMIT 1
    `).get(ruleId, String(chatId), `-${Math.max(1, seconds)} seconds`);
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
   * 用结算名单里的精确盈亏修正已结算注单的盈利（同群同期号的赢单）
   *
   * 常规结算用「点数 × 群赔率」估算盈利；结算名单里若出现本账号的中奖行，
   * 金额是游戏方给出的精确值，用它覆盖估算值（仅修正赢单，输单=本金无需修正）。
   *
   * @param {string} botUserId
   * @param {string} chatId
   * @param {string} period - 结算期号
   * @param {number} profit - 名单中解析出的净盈利
   * @returns {number} 实际修正的行数
   */
  refineWinProfit(botUserId, chatId, period, profit) {
    const db = getConnection();
    return db.prepare(`
      UPDATE action_logs
      SET profit = ?
      WHERE bot_user_id = ? AND chat_id = ? AND round_period = ?
        AND is_win = 1 AND settled_at IS NOT NULL AND profit != ?
    `).run(Number(profit), String(botUserId), String(chatId), String(period), Number(profit)).changes;
  },

  /**
   * 标记下注被机器人拒绝（余额不足等）
   *
   * 只在该笔「尚未结算」时生效：若已结算说明这笔注确实投出去了，
   * 不能因为后续一条余额播报就把它改判失败。
   *
   * @param {number} id
   * @param {string} errorMsg - 机器人给的失败原因
   * @returns {number} 实际更新行数（0 = 已结算，跳过）
   */
  markRejected(id, errorMsg) {
    const db = getConnection();
    return db.prepare(`
      UPDATE action_logs
      SET status = 'FAILED', error_msg = ?, settled_at = datetime('now', '+8 hours')
      WHERE id = ? AND settled_at IS NULL
    `).run(String(errorMsg || '').slice(0, 500), id).changes;
  },

  /**
   * 统计某时间点以来的记录数（清空今日前的确认文案）
   * @param {string} botUserId
   * @param {string} since - 'YYYY-MM-DD HH:mm:ss'
   */
  countSince(botUserId, since) {
    const db = getConnection();
    return db.prepare(`
      SELECT COUNT(*) AS n FROM action_logs
      WHERE bot_user_id = ? AND created_at >= ?
    `).get(String(botUserId), since).n;
  },

  /**
   * 删除某时间点以来的全部下注记录（清空今日记录，今日盈利随之归零）
   *
   * @param {string} botUserId
   * @param {string} since - 'YYYY-MM-DD HH:mm:ss'
   * @returns {number} 删除条数
   */
  deleteSince(botUserId, since) {
    const db = getConnection();
    return db.prepare('DELETE FROM action_logs WHERE bot_user_id = ? AND created_at >= ?')
      .run(String(botUserId), since).changes;
  },

  /**
   * 清空用户当前的待发 / 挂起标记
   *
   * 用于「清空今日记录」后：记录已被删除，若仍保留 pending，
   * 策略执行器会因找不到可结算记录而反复自愈告警。
   *
   * @param {string} botUserId
   * @returns {number} 清理的状态行数
   */
  clearLiveFlagsByUser(botUserId) {
    const db = getConnection();
    return db.prepare(`
      UPDATE rule_chat_state
      SET armed_direction = NULL, pending_direction = NULL,
          updated_at = datetime('now', '+8 hours')
      WHERE (armed_direction IS NOT NULL OR pending_direction IS NOT NULL)
        AND rule_id IN (SELECT id FROM rules WHERE bot_user_id = ?)
    `).run(String(botUserId)).changes;
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
