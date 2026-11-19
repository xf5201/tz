-- 006_simulate_wallet
-- 模拟模式提到账号级：整个账号一个「模拟钱包」，所有规则共用。
--   simulate            = 1 时全局只模拟：不下真注，但倍投/连败/止损/止盈/盈亏全部照常推演
--   sim_balance         模拟钱包余额（手动设置，默认 1000）
--   sim_initial_balance 模拟钱包初始额（用于展示盈亏百分比/重置）

-- #ifMissingColumn(accounts.simulate)
ALTER TABLE accounts ADD COLUMN simulate INTEGER NOT NULL DEFAULT 0 CHECK(simulate IN (0,1));

-- #ifMissingColumn(accounts.sim_balance)
ALTER TABLE accounts ADD COLUMN sim_balance REAL NULL;

-- #ifMissingColumn(accounts.sim_initial_balance)
ALTER TABLE accounts ADD COLUMN sim_initial_balance REAL NULL;
