-- migrations/005_dice_settlement_and_odds.sql
-- 输赢判定改造：由「结算名单匹配用户 ID」改为「机器人开奖点数直接判定」
-- 1) action_logs：round_period —— 注单所属期号（下注时从开盘消息/播报里取得），
--    结算只认同期的点数，杜绝「结算消息丢失后拿下一期名单判输赢」的错判
-- 2) chat_odds：按群动态学习的大/小赔率（来源：结算名单 中奖行 赢÷投注额）
--
-- 说明：同 002-004，每条 ADD COLUMN 前的 -- #ifMissingColumn 标记
-- 会让 migrate.js 在该列已存在时跳过，避免 SQLite 重复加列报错。

-- #ifMissingColumn(action_logs.round_period)
ALTER TABLE action_logs ADD COLUMN round_period TEXT NULL;

CREATE TABLE IF NOT EXISTS chat_odds (
    chat_id      TEXT PRIMARY KEY,
    -- 当前赔率（赢金额 ÷ 投注额，大/小，增量平均）
    odds         REAL NOT NULL,
    -- 已采纳的样本总数
    sample_count INTEGER NOT NULL DEFAULT 0,
    updated_at   DATETIME NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

-- 期号维度查注单（结算兜底 / 盈利修正）
CREATE INDEX IF NOT EXISTS idx_action_logs_chat_period
  ON action_logs(chat_id, round_period);
