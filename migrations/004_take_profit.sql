-- migrations/004_take_profit.sql
-- accounts：今日止盈目标 + 本轮盈利基准 + 停止状态
-- 说明：同 002/003，每条 ADD COLUMN 前的 -- #ifMissingColumn 标记
-- 会让 migrate.js 在该列已存在时跳过，避免 SQLite 重复加列报错。

-- #ifMissingColumn(accounts.take_profit)
ALTER TABLE accounts ADD COLUMN take_profit REAL NULL;

-- #ifMissingColumn(accounts.profit_baseline)
ALTER TABLE accounts ADD COLUMN profit_baseline REAL NULL;

-- #ifMissingColumn(accounts.profit_baseline_date)
ALTER TABLE accounts ADD COLUMN profit_baseline_date TEXT NULL;

-- #ifMissingColumn(accounts.profit_stopped)
ALTER TABLE accounts ADD COLUMN profit_stopped INTEGER NOT NULL DEFAULT 0;

-- #ifMissingColumn(accounts.profit_stopped_at)
ALTER TABLE accounts ADD COLUMN profit_stopped_at DATETIME NULL;
