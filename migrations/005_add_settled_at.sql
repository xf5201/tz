-- migrations/005_add_settled_at.sql
-- 补充结算时间列（004_add_bet_outcome 已加 is_win / profit）

ALTER TABLE action_logs ADD COLUMN settled_at DATETIME NULL;
