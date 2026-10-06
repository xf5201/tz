-- src/db/schema.sql
-- TG 群骰子开奖监听与自动下注系统 - 表结构
-- 与 pc28 同构：SQLite + WAL + bot_users/accounts/panel_context/操作日志，
-- 业务差异：监听群为多选（monitored_chats），规则为按群多条（rules）。

-- ═══════════════════════════════════════════
-- bot_users（Bot 用户）
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS bot_users (
    bot_user_id TEXT PRIMARY KEY,
    username    TEXT,
    first_name  TEXT,
    role        TEXT NOT NULL DEFAULT 'USER'
                CHECK(role IN ('USER','ADMIN')),
    is_allowed  INTEGER NOT NULL DEFAULT 1
                CHECK(is_allowed IN (0,1)),
    created_at  DATETIME NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

-- ═══════════════════════════════════════════
-- accounts（TG 执行账号）
-- 状态：PENDING_SETUP | ACTIVE | ERROR | LOGGED_OUT | DELETED
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS accounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_user_id    TEXT NOT NULL UNIQUE,
    phone          TEXT NOT NULL,
    session_string TEXT NOT NULL,
    listen_enabled INTEGER NOT NULL DEFAULT 1
                   CHECK(listen_enabled IN (0,1)),
    status         TEXT NOT NULL DEFAULT 'PENDING_SETUP'
                   CHECK(status IN ('PENDING_SETUP','ACTIVE','ERROR','LOGGED_OUT','DELETED')),
    last_error     TEXT NULL,
    -- 当前余额：由「下注后机器人回复的余额消息」解析写入（只认本账号自己的回复）
    balance        REAL NULL,
    balance_updated_at DATETIME NULL,
    created_at     DATETIME NOT NULL DEFAULT (datetime('now', '+8 hours')),
    updated_at     DATETIME NOT NULL DEFAULT (datetime('now', '+8 hours')),
    FOREIGN KEY (bot_user_id) REFERENCES bot_users(bot_user_id)
);

CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);

-- ═══════════════════════════════════════════
-- monitored_chats（监听群 - 一个账号可勾选多个）
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS monitored_chats (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_user_id TEXT NOT NULL,
    chat_id    TEXT NOT NULL,
    chat_title TEXT,
    chat_type  TEXT,
    created_at DATETIME NOT NULL DEFAULT (datetime('now', '+8 hours')),
    FOREIGN KEY (bot_user_id) REFERENCES bot_users(bot_user_id),
    UNIQUE(bot_user_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_monitored_chats_user ON monitored_chats(bot_user_id);

-- ═══════════════════════════════════════════
-- rules（规则 - 动态监测，作用于全部已勾选监听群）
--
-- 规则 = 连续 streak_count 次开出「大」→ 自动反向下注「小」；
--        连续 streak_count 次开出「小」→ 自动反向下注「大」。
-- 大 = 4-6 点，小 = 1-3 点。下注指令 "<方向标签> <金额>"。
-- 连败/挂起状态按「规则 × 群」记录在 rule_chat_state。
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS rules (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_user_id        TEXT NOT NULL,
    name               TEXT,
    streak_count       INTEGER NOT NULL DEFAULT 5,
    base_bet           INTEGER NOT NULL CHECK(base_bet > 0),
    martingale_ratio   REAL NOT NULL CHECK(martingale_ratio >= 1.0),
    max_lose_streak    INTEGER NOT NULL DEFAULT 6,
    stop_loss          REAL NULL,
    min_interval       INTEGER NOT NULL DEFAULT 3,
    dry_run            INTEGER NOT NULL DEFAULT 0
                       CHECK(dry_run IN (0,1)),
    enabled            INTEGER NOT NULL DEFAULT 1
                       CHECK(enabled IN (0,1)),
    created_at         DATETIME NOT NULL DEFAULT (datetime('now', '+8 hours')),
    updated_at         DATETIME NOT NULL DEFAULT (datetime('now', '+8 hours')),
    FOREIGN KEY (bot_user_id) REFERENCES bot_users(bot_user_id)
);

CREATE INDEX IF NOT EXISTS idx_rules_user_enabled ON rules(bot_user_id, enabled);

-- ═══════════════════════════════════════════
-- rule_chat_state（规则 × 群 的连败与挂起状态）
-- armed_direction   待发方向：连击已满足，等待「底注」开局消息后发送
-- pending_direction 挂起方向：已发送下注，等待下一条开奖结算
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS rule_chat_state (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id            INTEGER NOT NULL,
    chat_id            TEXT NOT NULL,
    consecutive_losses INTEGER NOT NULL DEFAULT 0,
    armed_direction    TEXT NULL,
    pending_direction  TEXT NULL,
    -- 该群是否被单独停注（连败/止损达到上限时只停这个群，规则本身继续跑）
    blocked            INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),
    blocked_reason     TEXT NULL,
    blocked_at         DATETIME NULL,
    -- 停注后是否已经出现过一次「连击中断」，用于下一次触发时自动恢复
    streak_broken      INTEGER NOT NULL DEFAULT 0 CHECK(streak_broken IN (0,1)),
    created_at         DATETIME NOT NULL DEFAULT (datetime('now', '+8 hours')),
    updated_at         DATETIME NOT NULL DEFAULT (datetime('now', '+8 hours')),
    FOREIGN KEY (rule_id) REFERENCES rules(id) ON DELETE CASCADE,
    UNIQUE(rule_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_rule_chat_state_blocked ON rule_chat_state(rule_id, blocked);

-- ═══════════════════════════════════════════
-- message_logs（开奖流水）
-- UNIQUE(chat_id, msg_id)：数据库层兜底去重
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS message_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_user_id TEXT,
    chat_id    TEXT NOT NULL,
    msg_id     TEXT NOT NULL,
    sender_id  TEXT,
    msg_type   TEXT,
    value      INTEGER,
    raw_text   TEXT,
    created_at DATETIME NOT NULL DEFAULT (datetime('now', '+8 hours')),
    UNIQUE(chat_id, msg_id)
);

CREATE INDEX IF NOT EXISTS idx_message_logs_user_created ON message_logs(bot_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_logs_chat_created ON message_logs(chat_id, created_at);

-- ═══════════════════════════════════════════
-- action_logs（下注记录）
-- 状态：CREATED | SENT | FAILED | DRY_RUN
-- 结算：输赢从群内「❤️第xxx期输赢」消息按用户 ID 匹配解析
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS action_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_user_id TEXT NOT NULL,
    rule_id     INTEGER,
    chat_id     TEXT NOT NULL,
    direction   TEXT NOT NULL,
    bet_amount  INTEGER NOT NULL,
    action_text TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'CREATED'
                CHECK(status IN ('CREATED','SENT','FAILED','DRY_RUN')),
    error_msg   TEXT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    is_win      INTEGER NULL,
    profit      REAL NULL,
    settled_at  DATETIME NULL,
    -- 本笔下注消息在群里的 msg_id（用于把机器人的余额回复归属到本账号）
    bet_msg_id  TEXT NULL,
    created_at  DATETIME NOT NULL DEFAULT (datetime('now', '+8 hours')),
    FOREIGN KEY (bot_user_id) REFERENCES bot_users(bot_user_id),
    FOREIGN KEY (rule_id) REFERENCES rules(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_action_logs_user_created ON action_logs(bot_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_action_logs_rule ON action_logs(rule_id);
CREATE INDEX IF NOT EXISTS idx_action_logs_bet_msg ON action_logs(chat_id, bet_msg_id);

-- ═══════════════════════════════════════════
-- operation_logs（操作日志）
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS operation_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_user_id TEXT NOT NULL,
    action      TEXT NOT NULL,
    detail      TEXT NULL,
    created_at  DATETIME NOT NULL DEFAULT (datetime('now', '+8 hours')),
    FOREIGN KEY (bot_user_id) REFERENCES bot_users(bot_user_id)
);

CREATE INDEX IF NOT EXISTS idx_operation_logs_user_created ON operation_logs(bot_user_id, created_at);

-- ═══════════════════════════════════════════
-- panel_context（面板上下文）
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS panel_context (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_user_id   TEXT NOT NULL UNIQUE,
    chat_id       INTEGER NOT NULL,
    message_id    INTEGER NOT NULL,
    current_panel TEXT NOT NULL DEFAULT 'dashboard',
    wizard_state  TEXT NULL,
    updated_at    DATETIME NOT NULL DEFAULT (datetime('now', '+8 hours')),
    FOREIGN KEY (bot_user_id) REFERENCES bot_users(bot_user_id)
);
