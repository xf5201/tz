-- migrations/002_dynamic_streak.sql
-- 规则模型简化（动态监测）：
--   旧模型：规则绑定单群 + 指定触发属性 + 指定下注方向
--   新模型：规则 = 连续 N 次开出大或小 → 自动反向下注，作用于全部已勾选监听群；
--           连败/挂起状态按「规则 × 群」记录在 rule_chat_state。

-- 1. 新建按「规则 × 群」的状态表（规则删除时级联清理）
CREATE TABLE IF NOT EXISTS rule_chat_state (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id            INTEGER NOT NULL,
    chat_id            TEXT NOT NULL,
    consecutive_losses INTEGER NOT NULL DEFAULT 0,
    pending_direction  TEXT NULL,
    created_at         DATETIME NOT NULL DEFAULT (datetime('now', '+8 hours')),
    updated_at         DATETIME NOT NULL DEFAULT (datetime('now', '+8 hours')),
    FOREIGN KEY (rule_id) REFERENCES rules(id) ON DELETE CASCADE,
    UNIQUE(rule_id, chat_id)
);

-- 2. 迁移旧规则的连败状态
INSERT OR IGNORE INTO rule_chat_state (rule_id, chat_id, consecutive_losses, pending_direction)
SELECT id, chat_id, consecutive_losses, NULL FROM rules;

-- 3. 删除引用了待删列的旧索引
DROP INDEX IF EXISTS idx_rules_user_chat;

-- 4. 删除废弃列（SQLite 3.35+ 支持 DROP COLUMN）
ALTER TABLE rules DROP COLUMN trigger_type;
ALTER TABLE rules DROP COLUMN attr;
ALTER TABLE rules DROP COLUMN bet_action;
ALTER TABLE rules DROP COLUMN chat_id;
ALTER TABLE rules DROP COLUMN consecutive_losses;
ALTER TABLE rules DROP COLUMN pending_bet;

-- 5. 重建规则查询索引
CREATE INDEX IF NOT EXISTS idx_rules_user_enabled
  ON rules(bot_user_id, enabled);
