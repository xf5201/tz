-- migrations/003_add_armed_direction.sql
-- 下注时机改造：连击条件满足后先进入「待发」状态（armed_direction），
-- 等识别到群里出现「底注」开局消息（下注窗口打开）才真正发送下注指令。
-- 识别词写死在代码中（strategy-executor BET_WINDOW_KEYWORD），不做配置。

ALTER TABLE rule_chat_state ADD COLUMN armed_direction TEXT NULL;
