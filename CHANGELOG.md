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
