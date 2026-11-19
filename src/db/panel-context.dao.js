// src/db/panel-context.dao.js
const { getConnection } = require('./connection');

/**
 * panel_context 表 DAO
 *
 * 接口：
 *   get / upsert / updatePanel / getActiveUsers / updateWizardState /
 *   clearWizardState / delete
 */
const panelContextDao = {
  /**
   * 获取用户的面板上下文
   * @param {string} botUserId
   * @returns {object|undefined}
   */
  get(botUserId) {
    const db = getConnection();
    return db.prepare('SELECT * FROM panel_context WHERE bot_user_id = ?').get(String(botUserId));
  },

  /**
   * 创建或更新面板上下文
   * @param {string} botUserId
   * @param {number} chatId
   * @param {number} messageId
   * @param {string} panelName
   */
  upsert(botUserId, chatId, messageId, panelName) {
    const db = getConnection();

    db.prepare(`
      INSERT INTO panel_context (bot_user_id, chat_id, message_id, current_panel)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(bot_user_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        message_id = excluded.message_id,
        current_panel = excluded.current_panel,
        updated_at = datetime('now', '+8 hours')
    `).run(String(botUserId), chatId, messageId, panelName);
  },

  /**
   * 更新当前面板名称
   * @param {string} botUserId
   * @param {string} panelName
   */
  updatePanel(botUserId, panelName) {
    const db = getConnection();

    db.prepare(`
      UPDATE panel_context
      SET current_panel = ?, updated_at = datetime('now', '+8 hours')
      WHERE bot_user_id = ?
    `).run(panelName, String(botUserId));
  },

  /**
   * 获取当前正在查看指定面板的所有用户
   * @param {string} panelName
   * @returns {Array<string>} bot_user_id 列表
   */
  getActiveUsers(panelName) {
    const db = getConnection();

    const rows = db.prepare('SELECT bot_user_id FROM panel_context WHERE current_panel = ?')
      .all(panelName);

    return rows.map((r) => r.bot_user_id);
  },

  /**
   * 更新登录 / 向导流程状态
   *
   * wizardState 示例：
   * {
   *   "scene": "login",
   *   "step": "phone",
   *   "phone": "+8613812341234"
   * }
   *
   * @param {string} botUserId
   * @param {string|null} wizardState JSON 字符串
   */
  updateWizardState(botUserId, wizardState) {
    const db = getConnection();

    db.prepare(`
      UPDATE panel_context
      SET wizard_state = ?, updated_at = datetime('now', '+8 hours')
      WHERE bot_user_id = ?
    `).run(wizardState ?? null, String(botUserId));
  },

  /**
   * 清空向导状态
   * @param {string} botUserId
   */
  clearWizardState(botUserId) {
    return this.updateWizardState(botUserId, null);
  },

  /**
   * 删除用户的面板上下文
   * @param {string} botUserId
   */
  delete(botUserId) {
    const db = getConnection();
    db.prepare('DELETE FROM panel_context WHERE bot_user_id = ?').run(String(botUserId));
  },
};

module.exports = panelContextDao;
