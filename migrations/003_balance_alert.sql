-- migrations/003_balance_alert.sql
-- accounts：初始余额（亏损基准）+ 亏损预警开关 + 告警去重时间
-- 说明：同 002，每条 ADD COLUMN 前的 -- #ifMissingColumn 标记
-- 会让 migrate.js 在该列已存在时跳过，避免 SQLite 重复加列报错。

-- #ifMissingColumn(accounts.initial_balance)
ALTER TABLE accounts ADD COLUMN initial_balance REAL NULL;

-- #ifMissingColumn(accounts.alert_enabled)
ALTER TABLE accounts ADD COLUMN alert_enabled INTEGER NOT NULL DEFAULT 0;

-- #ifMissingColumn(accounts.alert_notified_at)
ALTER TABLE accounts ADD COLUMN alert_notified_at DATETIME NULL;
