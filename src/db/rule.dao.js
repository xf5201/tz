// src/db/rule.dao.js
const { getConnection } = require('./connection');

/**
 * rules 表 DAO（动态监测规则，作用于全部已勾选监听群）
 *
 * 规则 = 连续 streak_count 次开出大/小 → 自动反向下注；
 * 连败/挂起状态在 rule_chat_state（见 rule-state.dao）。
 */
const ruleDao = {
  /**
   * 用户全部规则
   * @param {string} botUserId
   * @returns {Array}
   */
  listByUser(botUserId) {
    const db = getConnection();
    return db.prepare(`
      SELECT * FROM rules WHERE bot_user_id = ?
      ORDER BY created_at DESC
    `).all(String(botUserId));
  },

  /**
   * 单条规则
   * @param {number} id
   * @returns {object|undefined}
   */
  getById(id) {
    const db = getConnection();
    return db.prepare('SELECT * FROM rules WHERE id = ?').get(id);
  },

  /**
   * 用户全部启用规则（规则引擎扫描路径）
   */
  listEnabledByUser(botUserId) {
    const db = getConnection();
    return db.prepare(`
      SELECT * FROM rules
      WHERE bot_user_id = ? AND enabled = 1
      ORDER BY id
    `).all(String(botUserId));
  },

  /**
   * 新建规则
   * @param {object} data
   * @returns {number} 新规则 id
   */
  insert(data) {
    const db = getConnection();
    const info = db.prepare(`
      INSERT INTO rules (
        bot_user_id, name, streak_count, base_bet, martingale_ratio,
        max_lose_streak, stop_loss, min_interval, dry_run, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(data.bot_user_id),
      data.name || null,
      data.streak_count || 5,
      data.base_bet,
      data.martingale_ratio,
      data.max_lose_streak || 6,
      data.stop_loss ?? null,
      data.min_interval ?? 3,
      data.dry_run ? 1 : 0,
      data.enabled === 0 ? 0 : 1
    );
    return info.lastInsertRowid;
  },

  /**
   * 更新规则（部分字段）
   * @param {number} id
   * @param {object} fields
   */
  update(id, fields) {
    const db = getConnection();
    const allowed = [
      'name', 'streak_count', 'base_bet', 'martingale_ratio',
      'max_lose_streak', 'stop_loss', 'min_interval', 'dry_run', 'enabled',
    ];
    const sets = [];
    const values = [];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = ?`);
        values.push(fields[key]);
      }
    }
    if (!sets.length) return;
    sets.push("updated_at = datetime('now', '+8 hours')");
    values.push(id);
    db.prepare(`UPDATE rules SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  },

  /**
   * 删除规则（rule_chat_state 由外键级联清理）
   */
  deleteById(id) {
    const db = getConnection();
    db.prepare('DELETE FROM rules WHERE id = ?').run(id);
  },

  /**
   * 删除用户全部规则
   */
  deleteByUser(botUserId) {
    const db = getConnection();
    db.prepare('DELETE FROM rules WHERE bot_user_id = ?').run(String(botUserId));
  },

  /**
   * 统计
   */
  countByUser(botUserId) {
    const db = getConnection();
    return db.prepare('SELECT COUNT(*) AS n FROM rules WHERE bot_user_id = ?')
      .get(String(botUserId)).n;
  },

  countEnabledByUser(botUserId) {
    const db = getConnection();
    return db.prepare('SELECT COUNT(*) AS n FROM rules WHERE bot_user_id = ? AND enabled = 1')
      .get(String(botUserId)).n;
  },

  /**
   * 所有启用中的规则（启动恢复日志用）
   */
  getAllEnabled() {
    const db = getConnection();
    return db.prepare('SELECT * FROM rules WHERE enabled = 1').all();
  },
};

module.exports = ruleDao;
