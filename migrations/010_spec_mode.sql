-- 010_spec_mode.sql
-- 新增玩法模式（mode）：
--   0 = CLASSIC   原玩法：连击触发 → 反向下注「大/小」
--   1 = SPEC_FIVE 独立玩法：每期开奖后自动下注「最近 5 个不同数」定位胆
--       （每数一份额；可执行实现为独立规则，不下大/小）
-- 增量迁移：旧库自动补列，历史规则默认 mode=0，行为完全不变。
-- #ifMissingColumn(rules.mode)
ALTER TABLE rules ADD COLUMN mode INTEGER NOT NULL DEFAULT 0 CHECK(mode IN (0,1));