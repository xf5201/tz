-- 010_spec_mode.sql
-- 新增玩法模式（mode）：
--   0 = CLASSIC   原玩法：连击触发 → 反向下注「大/小」（保持 v3.4.0 原口径，不动）
--   1 = SPEC_FIVE 新玩法：连击触发 → 大/小 照常下注 + 伴随一手「最近 5 个不同数」的定位胆（每数一份额，赔率 5.8）
-- 增量迁移：旧库自动补列，历史规则默认 mode=0，行为完全不变。
-- #ifMissingColumn(rules.mode)
ALTER TABLE rules ADD COLUMN mode INTEGER NOT NULL DEFAULT 0 CHECK(mode IN (0,1))