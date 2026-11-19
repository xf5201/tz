# Changelog

## [1.0.0] - 2026-11-19
# 第一版：纯 TDlib 全链路（无 GramJS）

## 架构
- 登录 / 恢复 / 监听 / 下注 / 群列表 / 骰子解析 / 余额查询 / 结算判定
  全链路统一走官方 TDlib（koffi + libtdjson.so），彻底移除 GramJS 依赖
- 登录态由 TDlib binlog 持久化，重启自动恢复，不再 401

## 修复（相对旧 v3 系历史遗留）
- setDatabaseEncryptionKey 只在首次建库时调用，杜绝数据库存在时 401
- 登录流程与恢复流程统一为 TDlib（旧版 GramJS 登录 + TDlib 恢复混用导致重启掉登录）
- TDlib 版 getDialogs / sendMessage / getMessages / chat_id 转换补齐，
  监听群配置、下注、余额查询不再调用不存在的 GramJS 方法
- 骰子解析改读 TDlib 原生结构（messageDice），回复归属改读 message.reply

## 补充修复（2026-11-19，仍在 v1.0.0 内，不升版本）
- 开盘信号是 messageAnimation（GIF），文本在 caption 不在 messageText → toGramjsMessage 增加 caption 提取，下注恢复正常
- 休息到点不重连（原 5 分钟休息且只能靠消息触发）→ 改为 20~30 分钟随机休息 +
  30 秒独立巡检定时器，时间到自动重连，不再依赖群里消息
- 余额自动同步两连修：
  1. sendMessage 返回 TDlib 本地乐观 id，与机器人 reply_to 服务端 id 对不上 →
     发送后拉最新历史校正真实 id（带回滚兜底）
  2. 归属改用「艾特实体」：机器人回复＝艾特我们（textEntityTypeMentionName 实体
     带 user_id，实测 1092068467），_resolveBalanceOwner 优先按实体账号 id 归属，
     reply_to 匹配降为兜底 —— 余额播报自动落库，不再需要手动初始化
- getDialogs 双负号 id 修复（-100xxx 被拼成 -100-100xxx）→ 直接 String(id)；
  _toTdlibChatId 兼容单负号原样返回、仅双负号剥一层
