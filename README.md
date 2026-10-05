# TG 群监听下注系统（tg-monitor-bot）

Telegram 群骰子开奖监听与自动下注系统。（SQLite + DAO +
面板式 Bot + services 分层），仅业务不同：监听用户勾选的**多个群** → 识别骰子开奖
（1–6 点）→ 按全按钮化配置的规则自动下注（大/小/单/双）。

> 旧版 TypeScript + Prisma + PostgreSQL + Vue 控制台实现已归档至 `E:\1\tg-monitor-bot-ts-backup.tgz`。

## 架构（与 pc28 一致）

```
tg-monitor-bot/
├── ecosystem.config.js            # PM2 进程编排
├── migrations/                    # 增量 SQL 迁移（001_add_perf_indexes.sql）
├── data/                          # SQLite 数据库文件（gitignore）
└── src/
    ├── index.js                   # 启动入口（配置→DB→迁移→服务装配→Session恢复→Bot）
    ├── bot/
    │   ├── commands/start.command.js
    │   ├── handlers/              # callback.router + dashboard/account/login/login-text/
    │   │                          # chat/rule/log/report
    │   ├── middleware/            # whitelist（白名单）/ callback（幂等）/ panel（上下文注入）
    │   ├── panels/                # panel.renderer（单消息编辑+自愈）+ 8 个业务面板
    │   └── scenes/input.scene.js  # 自定义数值 / 群名搜索输入
    ├── core/
    │   ├── dice.parser.js         # 骰子开奖消息解析（🎲🎯⚽🏀🎳，1–6 点）
    │   ├── number.attributes.js   # 大小单双判定：BIG 4-6｜SMALL 1-3｜ODD 奇｜EVEN 偶
    │   └── rule.engine.js         # 触发判定（OPEN/STREAK）、倍投金额、指令文本生成
    ├── db/                        # connection(WAL) / schema.sql / migrate.js / 8 个 DAO
    ├── services/
    │   ├── session.manager.js     # TG Client 连接池（按 botUserId 隔离、启动恢复）
    │   ├── account.service.js     # 登录（验证码+2FA）/ 登出 / 删除 / 监听群管理
    │   ├── listener.service.js    # NewMessage 监听、群白名单、去重、流水入库
    │   ├── strategy-executor.service.js  # 结算挂起下注 → 止损检查 → 触发判定 → 生成动作
    │   ├── bet-sender.service.js  # 发送「大 100」类指令（超时保护+退避重试）
    │   └── notification.service.js
    └── utils/                     # logger / config.loader / mask / format
```

## 规则模型（动态监测，全按钮化，无自由模板）

规则只有一套逻辑：**同一监听群内连续 N 把开出「大」→ 自动买「小」；连续 N 把开出「小」→ 自动买「大」**（方向自动取反，大小两个方向独立监测，无单双）。

| 配置项 | 按钮 |
| --- | --- |
| 连续次数 N | 预设 3/4/5/6/8/10/12/15 把 + 自定义输入（2–50） |
| 基础金额 | 预设 10/50/100/500 + 自定义输入 |
| 倍投比例 | 预设 1.5/2.0/2.5/3.0 + 自定义输入 |
| 连败上限 | 预设 3/5/6/10 + 自定义输入 |
| 止损上限 | 预设 200/500/1000/5000 + 不限 + 自定义输入 |
| 最小间隔 | 预设 0/3/5/10 秒 |

- **作用范围**：规则自动作用于全部已勾选的监听群，每个群独立计数、独立结算（rule_chat_state 表）。
- 下注指令格式与 pc28 相同：`小 100`（方向标签 + 空格 + 金额），金额 = 基础 × 比例^该群连败数。
- 结算：规则在群里发出下注后挂起，该群下一条开奖结算——命中方向赢（连败清零），否则输（连败 +1，连击延续会立即按倍投金额再次触发）。
- 连败达上限或累计投入达止损 → 规则自动停用并通知，人工启用恢复（启用时清零连败）。
- 模拟模式：单条规则 🧪 开关，只记录不发送。
- 多群：监听群列表每群一个 ✅/⬜ 切换按钮，分页 + 全选本页 + 群名搜索，确认后热更新生效。

## 快速开始

```bash
# 1. 配置（兼容 TG_API_ID/API_ID 两种变量名）
cp .env.example .env      # 填入 BOT_TOKEN / TG_API_ID / TG_API_HASH

# 2. 启动（SQLite 内嵌，无需任何外部数据库）
npm start                 # 或 node --watch src/index.js 开发调试

# 3. 生产环境（PM2，与 pc28 相同）
pm2 start ecosystem.config.js
```

在 Telegram 打开你的 Bot → `/start` → 登录执行账号 → 配置监听群 → 配置规则。

## 与 pc28 的对应关系

| pc28 | 本项目 | 差异 |
| --- | --- | --- |
| strategy_config（每用户一条策略） | rules 表（多条规则，动态连击反买） | 业务需要按 N 灵活组合 |
| accounts.target_chat_id（单群） | monitored_chats 表（多群） | 用户要求多群监听 |
| crawler 拉取 PC28 开奖 | listener 实时监听 + dice-poller 按群轮询兜底（实测部分群组服务器不推送实时更新，Raw 层 0 推送但 getMessages 正常，故轮询拉取开奖，与 pc28 crawler 同理） | 开奖来源不同 |
| settlement 结算 | strategy-executor 按群挂起下注由下条开奖结算 | 结算机制适配骰子业务 |
| 其余：bot_users 白名单、panel.renderer、middleware、input.scene、DAO、migrate、PM2 编排 | 完全同构 | — |

## 安全与合规

- 登录仅允许 Bot 对话所属的本人账号；白名单（bot_users.is_allowed）可关闭使用权限。
- 手机号日志脱敏；验证码 / 2FA 密码输入后消息立即删除且不落日志。
- 内置 20 次/分钟单群限流、同群最小动作间隔、连败/止损自动停用。
- 请遵守 Telegram 服务条款与所在地法律法规；建议先用模拟模式（🧪）验证策略。
