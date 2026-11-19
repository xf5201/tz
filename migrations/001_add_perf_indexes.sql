-- migrations/001_add_perf_indexes.sql
-- 高频查询路径的增量索引（README 架构说明中列出的文件）
-- 全部使用 IF NOT EXISTS，可安全重复执行

-- 连击判定：按群取最近 N 条开奖
CREATE INDEX IF NOT EXISTS idx_message_logs_chat_value_created
  ON message_logs(chat_id, created_at DESC, id DESC);

-- 结算查询：按规则 × 群找未结算记录
CREATE INDEX IF NOT EXISTS idx_action_logs_rule_chat_status
  ON action_logs(rule_id, chat_id, status, settled_at);

-- 今日盈利/报表：按用户 + 结算时间
CREATE INDEX IF NOT EXISTS idx_action_logs_user_settled
  ON action_logs(bot_user_id, settled_at);

-- 挂起巡检：按更新时间扫描挂起状态
CREATE INDEX IF NOT EXISTS idx_rule_chat_state_updated
  ON rule_chat_state(updated_at);
