-- migrations/004_add_bet_outcome.sql
-- 下注记录支持输赢与盈亏：
--   is_win  → 1 赢 / 0 输（开奖结算时写入）
--   profit  → 盈亏金额（赢 = 下注金额 × 0.95，与群内实际赔率一致；输 = -下注金额）

ALTER TABLE action_logs ADD COLUMN is_win INTEGER NULL;
ALTER TABLE action_logs ADD COLUMN profit REAL NULL;
