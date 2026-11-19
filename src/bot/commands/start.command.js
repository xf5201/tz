// src/bot/commands/start.command.js
const botUserDao = require('../../db/bot-user.dao');
const accountDao = require('../../db/account.dao');
const monitoredChatDao = require('../../db/monitored-chat.dao');
const ruleDao = require('../../db/rule.dao');
const messageLogDao = require('../../db/message-log.dao');
const actionLogDao = require('../../db/action-log.dao');
const logger = require('../../utils/logger');

/**
 * /start 命令处理器
 *
 * 调用链：
 *   start.command.js
 *   → deleteQuietly(ctx)  // 先删除用户发送的指令消息，防止与后发的面板混料
 *   → bot-user.dao.upsert(...)
 *   → 聚合账号 / 监听群 / 规则 / 吞吐数据
 *   → panelRenderer.render(ctx, 'dashboard', ..., { forceNew: true })  // 强制弹出新面板
 */
async function handleStart(ctx, { panelRenderer }) {
  const tgUser = ctx.from;
  const botUserId = String(tgUser.id);

  try {
    // 1. ✅ 先静默删除用户发送的 /start 文本命令，保证界面干净
    await deleteQuietly(ctx);

    // 2. 初始化 / 更新 bot_users 记录
    botUserDao.upsert({
      bot_user_id: botUserId,
      username: tgUser.username || null,
      first_name: tgUser.first_name || null,
    });

    // 3. 聚合主面板数据
    const account = accountDao.getActive(botUserId);
    const chats = monitoredChatDao.listByUser(botUserId);
    const rules = ruleDao.listByUser(botUserId);
    const throughput = messageLogDao.countRecent(botUserId, 10);
    const latestFailed = actionLogDao.latestFailed(botUserId);

    // 4. 渲染主面板（forceNew: true 强制生成新面板）
    await panelRenderer.render(
      ctx,
      'dashboard',
      { user: { id: botUserId, username: tgUser.username, first_name: tgUser.first_name }, account, chats, rules, throughput, latestFailed },
      { forceNew: true }
    );

    logger.info(`[START] 用户 ${botUserId} 已注册并展示主面板`);
  } catch (error) {
    logger.error(`[START] 处理失败: ${error.message}`, error);
  }
}

/**
 * 静默删除消息（失败不影响流程）
 */
async function deleteQuietly(ctx) {
  try {
    await ctx.deleteMessage();
  } catch (_) { /* 忽略 */ }
}

module.exports = { handleStart };
