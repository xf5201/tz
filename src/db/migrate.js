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
 * 判断表中是否存在某列
 * @param {Database} db
 * @param {string} table
 * @param {string} column
 * @returns {boolean}
 */
function columnExists(db, table, column) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some((c) => c.name === column);
  } catch (_) {
    return false;
  }
}

/**
 * 执行一段迁移 SQL
 *
 * 支持条件语句标记（SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS，
 * 旧库已经建过列时重复执行会直接报错）：
 *   -- #ifMissingColumn(表名.列名)
 *   ALTER TABLE 表名 ADD COLUMN 列名 ...;
 * 标记所在的语句仅在「该列不存在」时执行，存在则跳过。
 *
 * @param {Database} db
 * @param {string} sql - 迁移文件全文
 */
function execSqlStatements(db, sql) {
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const statement of statements) {
    const marker = /--\s*#ifMissingColumn\(\s*([A-Za-z0-9_]+)\s*\.\s*([A-Za-z0-9_]+)\s*\)/.exec(statement);
    if (marker && columnExists(db, marker[1], marker[2])) {
      logger.debug(`[MIGRATE] 列已存在，跳过: ${marker[1]}.${marker[2]}`);
      continue;
    }
    db.exec(`${statement};`);
  }
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
    execSqlStatements(db, sql);
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
      execSqlStatements(db, sql);
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
