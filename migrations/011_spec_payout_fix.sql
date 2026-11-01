-- 011_spec_payout_fix.sql
-- 定位胆（SPEC_FIVE）金额口径与群级赔率修复（2026-10-31）：
--   1. action_logs.stake_per_number：定位胆注单显式记录单注金额。
--      bet_amount 一直存整组总投入（5A），但 2026-10-31 之前的行若是从旧口径
--      （bet_amount=单注A）写入的，_profitFor 无法区分。该列落库后：
--        赢单净利 = stake_per_number × (倍率 − 5)；
--        该列为 NULL 的历史定位胆行按 bet_amount ÷ 5 均分（新口径行恰为正确值）。
--   2. chat_odds.spec_odds / spec_sample_count：群级定位胆含本金倍率学习列，
--      从结算名单定位胆行（赢+投)/投 动态校准；无样本时用全局 DICE_SPEC_PAYOUT。
-- 增量迁移：旧库自动补列，行为兼容。
-- #ifMissingColumn(action_logs.stake_per_number)
ALTER TABLE action_logs ADD COLUMN stake_per_number REAL NULL;
-- #ifMissingColumn(chat_odds.spec_odds)
ALTER TABLE chat_odds ADD COLUMN spec_odds REAL NULL;
-- #ifMissingColumn(chat_odds.spec_sample_count)
ALTER TABLE chat_odds ADD COLUMN spec_sample_count INTEGER NOT NULL DEFAULT 0;