// src/db/migrate.js
const fs = require('fs');
const path = require('path');
const { getConnection } = require('./connection');
const logger = require('../utils/logger');

/**
 * 数据库迁移执行器
 *
 * 职责：
 *   - 创建 migration_history 追踪表
 *   - 按文件名顺序执行 migrations/ 目录下的 SQL 文件
 *   - 跳过已执行的迁移
 *   - 支持首次建表（执行 schema.sql）
 */

/**
 * 确保 migration_history 表存在
 */
function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      executed_at DATETIME NOT NULL DEFAULT (datetime('now', '+8 hours'))
    );
  `);
}

/**
 * 获取已执行的迁移列表
 * @returns {Set<string>}
 */
function getExecutedMigrations(db) {
  const rows = db.prepare('SELECT name FROM migration_history').all();
  return new Set(rows.map((r) => r.name));
}

/**
 * 执行所有待执行的迁移
 */
function runMigrations() {
  const db = getConnection();

  ensureMigrationTable(db);

  const executed = getExecutedMigrations(db);

  // 1. 先执行 schema.sql（首次建表）
  const schemaPath = path.join(__dirname, 'schema.sql');
  if (fs.existsSync(schemaPath) && !executed.has('schema.sql')) {
    const sql = fs.readFileSync(schemaPath, 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO migration_history (name) VALUES (?)').run('schema.sql');
    logger.info('[MIGRATE] 已执行: schema.sql');
    executed.add('schema.sql');
  }

  // 2. 执行 migrations/ 目录下的增量迁移
  const migrationsDir = path.join(process.cwd(), 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    logger.info('[MIGRATE] migrations 目录不存在，跳过增量迁移');
    return;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // 按文件名排序（001_init.sql, 002_xxx.sql ...）

  for (const file of files) {
    if (executed.has(file)) {
      logger.debug(`[MIGRATE] 跳过已执行: ${file}`);
      continue;
    }

    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    try {
      db.exec(sql);
      db.prepare('INSERT INTO migration_history (name) VALUES (?)').run(file);
      logger.info(`[MIGRATE] 已执行: ${file}`);
    } catch (error) {
      logger.error(`[MIGRATE] 执行失败: ${file} → ${error.message}`, error);
      throw error;
    }
  }

  logger.info('[MIGRATE] 所有迁移执行完成');
}

module.exports = { runMigrations };
