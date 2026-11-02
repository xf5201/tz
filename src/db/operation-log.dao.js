// src/db/operation-log.dao.js
const { getConnection } = require('./connection');

/**
 * operation_logs 表 DAO
 *
 * ⚠️ 已按需求下线「操作日志」功能（2026-10-05）：
 *   - insert 改为空操作，不再写入（历史表保留，不再增长）
 *   - Bot 面板中的「操作日志」入口已移除
 * 各处保留 require 以免改动扩散，均为 no-op。
 */
const operationLogDao = {
  /**
   * 写入操作日志（已停用，空操作）
   */
  insert(_data) {
    /* no-op：操作日志功能已下线 */
  },

  /**
   * 用户操作日志（已停用，返回空数组）
   */
  listByUser(_botUserId, _opts = {}) {
    return [];
  },

  /**
   * 删除用户全部操作日志（删除账号时清理历史数据，保留）
   */
  deleteByUser(botUserId) {
    const db = getConnection();
    db.prepare('DELETE FROM operation_logs WHERE bot_user_id = ?').run(String(botUserId));
  },
};

module.exports = operationLogDao;
