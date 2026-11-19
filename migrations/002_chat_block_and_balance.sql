-- migrations/002_chat_block_and_balance.sql
-- 1) rule_chat_state：按群停注（blocked / blocked_reason / blocked_at / streak_broken）
-- 2) accounts：当前余额（balance / balance_updated_at）
-- 3) action_logs：下注消息 ID（bet_msg_id），用于余额回复归属
--
-- 说明：SQLite 的 ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS，
-- 已建过列的旧库重复执行会报错。因此每个 ADD COLUMN 前加
--   -- #ifMissingColumn(表名.列名)
-- 标记，由 migrate.js 检测列是否存在，存在则跳过该条语句。

-- #ifMissingColumn(rule_chat_state.blocked)
ALTER TABLE rule_chat_state ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;

-- #ifMissingColumn(rule_chat_state.blocked_reason)
ALTER TABLE rule_chat_state ADD COLUMN blocked_reason TEXT NULL;

-- #ifMissingColumn(rule_chat_state.blocked_at)
ALTER TABLE rule_chat_state ADD COLUMN blocked_at DATETIME NULL;

-- #ifMissingColumn(rule_chat_state.streak_broken)
ALTER TABLE rule_chat_state ADD COLUMN streak_broken INTEGER NOT NULL DEFAULT 0;

-- #ifMissingColumn(accounts.balance)
ALTER TABLE accounts ADD COLUMN balance REAL NULL;

-- #ifMissingColumn(accounts.balance_updated_at)
ALTER TABLE accounts ADD COLUMN balance_updated_at DATETIME NULL;

-- #ifMissingColumn(action_logs.bet_msg_id)
ALTER TABLE action_logs ADD COLUMN bet_msg_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_rule_chat_state_blocked ON rule_chat_state(rule_id, blocked);
CREATE INDEX IF NOT EXISTS idx_action_logs_bet_msg ON action_logs(chat_id, bet_msg_id);
