// src/db/connection.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

/**
 * SQLite 连接管理（单例）
 *
 * PRAGMA：
 *   journal_mode = WAL       → 并发读写
 *   busy_timeout = 5000      → 锁等待 5 秒
 *   synchronous = NORMAL     → 性能与安全的平衡
 *   foreign_keys = ON        → 启用外键约束
 *   temp_store = MEMORY      → 临时表存内存
 *   cache_size = -8000       → 8MB 缓存
 */

let db = null;

/**
 * 获取数据库连接（单例）
 * @returns {Database}
 */
function getConnection() {
  if (db) return db;

  const dbPath = process.env.DATABASE_PATH || './data/database.db';
  const resolvedPath = path.resolve(dbPath);

  // 确保目录存在
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(resolvedPath);

  // 执行 PRAGMA
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -8000');

  logger.info(`[DB] SQLite 连接已建立: ${resolvedPath}`);

  return db;
}

/**
 * 执行事务（BEGIN IMMEDIATE）
 *
 * 用于关键写操作：service 层调用 transaction(fn)
 *
 * @param {function} fn - 事务内执行的函数，接收 db 实例
 * @returns {*} fn 的返回值
 */
function transaction(fn) {
  const conn = getConnection();
  const run = conn.transaction(fn);
  return run();
}

/**
 * 关闭数据库连接
 */
function close() {
  if (db) {
    db.close();
    db = null;
    logger.info('[DB] SQLite 连接已关闭');
  }
}

module.exports = {
  getConnection,
  transaction,
  close,
};
