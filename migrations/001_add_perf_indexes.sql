-- migrations/001_add_perf_indexes.sql
-- 补充性能索引：流水查询与连击历史读取专用，避免随数据量增长的全表扫描

-- 连击历史：按群取最近 N 条开奖
CREATE INDEX IF NOT EXISTS idx_message_logs_chat_msg
  ON message_logs(chat_id, msg_id DESC);

-- 规则扫描：按用户取全部启用规则
CREATE INDEX IF NOT EXISTS idx_rules_user_enabled
  ON rules(bot_user_id, enabled);
