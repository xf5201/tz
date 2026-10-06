// src/index.js
/**
 * TG 群监听下注系统 - 启动入口
 *
 * 架构与 pc28 同构。
 *
 * 启动顺序：
 *   1. 加载 .env 配置
 *   2. 初始化 logger
 *   3. 初始化 DB + PRAGMA
 *   4. 执行 migrations
 *   5. 初始化 Bot + 中间件 + 面板渲染器 + Services
 *   6. 恢复 Session（loadActiveSessions）并启动各账号监听
 *   7. 恢复规则状态（启用规则的连败/挂起标记已在库中）
 *   8. 启动数据保留定时清理
 *   9. 启动 Bot
 *  10. SYSTEM_READY
 */

const { Telegraf, session, Scenes } = require('telegraf');

// ── Utils ──
const { getConfig } = require('./utils/config.loader');
const logger = require('./utils/logger');

// ── DB ──
const { getConnection, close: closeDb } = require('./db/connection');
const { runMigrations } = require('./db/migrate');
const accountDao = require('./db/account.dao');
const ruleDao = require('./db/rule.dao');
const ruleStateDao = require('./db/rule-state.dao');
const monitoredChatDao = require('./db/monitored-chat.dao');
const messageLogDao = require('./db/message-log.dao');
const actionLogDao = require('./db/action-log.dao');
const panelContextDao = require('./db/panel-context.dao');

// ── Services ──
const SessionManager = require('./services/session.manager');
const AccountService = require('./services/account.service');
const ListenerService = require('./services/listener.service');
const DicePollerService = require('./services/dice-poller.service');
const MessageDispatcherService = require('./services/message-dispatcher.service');
const { StrategyExecutorService } = require('./services/strategy-executor.service');
const BetSenderService = require('./services/bet-sender.service');
const NotificationService = require('./services/notification.service');

// ── Bot ──
const PanelRenderer = require('./bot/panels/panel.renderer');
const CallbackRouter = require('./bot/handlers/callback.router');
const whitelistMiddleware = require('./bot/middleware/whitelist.middleware');
const callbackMiddleware = require('./bot/middleware/callback.middleware');
const panelMiddleware = require('./bot/middleware/panel.middleware');
const { handleStart } = require('./bot/commands/start.command');

// ── Handlers ──
const LoginTextHandler = require('./bot/handlers/login-text.handler');

// ── Scenes ──
const inputScene = require('./bot/scenes/input.scene');

/**
 * 主启动函数
 */
async function main() {
  // ═══════════════════════════════════════════
  // 1. 加载 .env 配置
  // ═══════════════════════════════════════════
  let config;
  try {
    config = getConfig();
    console.log('[BOOT] 配置加载完成');
  } catch (error) {
    console.error('[BOOT] 配置加载失败:', error.message);
    process.exit(1);
  }

  // ═══════════════════════════════════════════
  // 2. 初始化 logger
  // ═══════════════════════════════════════════
  logger.init();
  logger.info('[BOOT] Logger 已初始化');
  logger.audit('SYSTEM_START', { env: config.nodeEnv });

  // ═══════════════════════════════════════════
  // 3. 初始化 DB + PRAGMA
  // ═══════════════════════════════════════════
  getConnection();
  logger.info('[BOOT] SQLite 连接已建立');

  // ═══════════════════════════════════════════
  // 4. 执行 migrations
  // ═══════════════════════════════════════════
  runMigrations();
  logger.info('[BOOT] 数据库迁移完成');

  // ═══════════════════════════════════════════
  // 5. 初始化 Bot + 中间件 + 面板渲染器 + Services
  // ═══════════════════════════════════════════
  const bot = new Telegraf(config.botToken);

  // 面板渲染器
  const panelRenderer = new PanelRenderer(bot, panelContextDao);

  // ── 初始化 Services ──
  const sessionManager = new SessionManager({
    apiId: config.tgApiId,
    apiHash: config.tgApiHash,
  });

  const notificationService = new NotificationService({ bot, panelRenderer });

  const betSender = new BetSenderService({ sessionManager, notification: notificationService });

  const strategyExecutor = new StrategyExecutorService({
    betSender,
    notification: notificationService,
  });

  // 消息分发器（唯一消息入口）：分类 → (chat_id,msg_id) 全局去重 → 按群分发给全部在线监听账号
  const messageDispatcher = new MessageDispatcherService({
    sessionManager,
    strategyExecutor,
  });

  const listenerService = new ListenerService({ messageDispatcher });

  // 骰子开奖轮询（pc28 crawler 同构）：部分群组服务器不推送实时更新，按群轮询兜底
  const dicePoller = new DicePollerService({
    sessionManager,
    messageDispatcher,
    intervalMs: config.dicePollIntervalMs,
  });

  // 登录成功后自动挂载该账号的消息监听
  const accountService = new AccountService(sessionManager, {
    apiId: config.tgApiId,
    apiHash: config.tgApiHash,
  }, {
    onConnected: async (botUserId, client) => {
      accountDao.updateStatus(botUserId, 'ACTIVE');
      listenerService.startForUser(botUserId, client);
    },
  });

  // 聚合 services（供 handler / scene 使用）
  const services = {
    account: accountService,
    session: sessionManager,
    listener: listenerService,
    strategyExecutor,
    betSender,
    notification: notificationService,
    panelRenderer,
    panelContextDao,
  };

  // ── 注入 services 到 ctx（供 handler / scene 使用） ──
  bot.use((ctx, next) => {
    ctx.services = services;
    return next();
  });

  // ── 中间件（顺序很重要） ──
  bot.use(session()); // Telegraf session（Scene 需要）
  bot.use(whitelistMiddleware);
  bot.use(callbackMiddleware);
  bot.use(panelMiddleware);

  // ── Scenes ──
  const stage = new Scenes.Stage([inputScene], {
    ttl: 300, // Scene 超时 5 分钟
  });
  bot.use(stage.middleware());

  // ── 登录文本拦截 ──
  // 用于拦截用户在登录面板中输入的手机号、验证码、2FA 密码
  const loginTextHandler = new LoginTextHandler({
    panelRenderer,
    panelContextDao,
    accountService,
  });

  bot.on('text', async (ctx, next) => {
    const handled = await loginTextHandler.handle(ctx);
    if (handled) return; // 如果已被登录处理器处理，则不继续向下传递
    return next();
  });

  // ── Callback Router ──
  const callbackRouter = new CallbackRouter(panelRenderer, services);
  bot.on('callback_query', (ctx) => callbackRouter.handle(ctx));

  // ── Commands ──
  bot.start((ctx) => handleStart(ctx, { panelRenderer }));

  // ── 定时刷新主面板（与 pc28 同款防重叠闸门） ──
  let refreshRunning = false;
  const beijingMidnight = () => {
    const shifted = new Date(Date.now() + 8 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} 00:00:00`;
  };
  const refreshTimer = setInterval(async () => {
    if (refreshRunning) return;
    refreshRunning = true;
    try {
      const activeUsers = panelContextDao.getActiveUsers('dashboard');
      for (const userId of activeUsers) {
        try {
          const account = accountDao.getActive(userId);
          const chats = monitoredChatDao.listByUser(userId);
          const rules = ruleDao.listByUser(userId);
          const throughput = messageLogDao.countRecent(userId, 10);
          const latestFailed = actionLogDao.latestFailed(userId);
          const todayProfit = Math.round(actionLogDao.sumProfit(userId, beijingMidnight()) * 100) / 100;
          await panelRenderer.pushUpdate(userId, 'dashboard', {
            user: { id: userId },
            account,
            chats,
            rules,
            throughput,
            todayProfit,
            latestFailed,
          });
        } catch (err) {
          logger.warn(`[BOOT] 定时刷新面板失败: 用户=${userId}, ${err.message}`);
        }
      }
    } catch (err) {
      logger.warn(`[BOOT] 定时刷新面板异常: ${err.message}`);
    } finally {
      refreshRunning = false;
    }
  }, 30000); // 30 秒刷新一次
  if (refreshTimer.unref) refreshTimer.unref();

  // ═══════════════════════════════════════════
  // 6. 恢复 Session 并启动各账号监听
  // ═══════════════════════════════════════════
  logger.info('[BOOT] 开始恢复 Session...');
  await sessionManager.loadActiveSessions({
    onConnected: async (botUserId, client) => {
      listenerService.startForUser(botUserId, client);
    },
  });
  logger.info(`[BOOT] Session 恢复完成，活跃连接: ${sessionManager.getActiveCount()}`);

  // ═══════════════════════════════════════════
  // 6.5 启动骰子开奖轮询兜底
  // ═══════════════════════════════════════════
  dicePoller.start();

  // ═══════════════════════════════════════════
  // 7. 恢复规则状态（各群连败/挂起状态全部在库中）
  // ═══════════════════════════════════════════
  const enabledRules = ruleDao.getAllEnabled();
  const pendingCount = ruleStateDao.countPending();
  if (enabledRules.length > 0) {
    logger.info(`[BOOT] 启用中的规则 ${enabledRules.length} 条（${pendingCount} 笔挂起下注，等待下次开奖结算）`);
  } else {
    logger.info('[BOOT] 没有启用中的规则');
  }

  // ═══════════════════════════════════════════
  // 8. 数据保留定时清理（每小时）+ 挂起超时巡检（每分钟）
  // ═══════════════════════════════════════════
  const cleanupTimer = setInterval(() => {
    try {
      const msgCutoff = beijingOffset(-config.messageRetentionDays);
      const actCutoff = beijingOffset(-config.actionRetentionDays);
      const removedMsg = messageLogDao.purgeBefore(msgCutoff);
      const removedAct = actionLogDao.purgeBefore(actCutoff);
      if (removedMsg || removedAct) {
        logger.info(`[BOOT] 数据清理完成: 流水 ${removedMsg} 条、动作记录 ${removedAct} 条`);
      }
    } catch (err) {
      logger.warn(`[BOOT] 数据清理失败: ${err.message}`);
    }
  }, 3600 * 1000);
  if (cleanupTimer.unref) cleanupTimer.unref();

  // 挂起超时巡检：结算消息丢失时解除卡死的挂起，避免「规则 × 群」永久停摆
  const pendingSweepTimer = setInterval(() => {
    strategyExecutor.sweepStalePending().catch((err) => {
      logger.warn(`[BOOT] 挂起超时巡检失败: ${err.message}`);
    });
  }, 60 * 1000);
  if (pendingSweepTimer.unref) pendingSweepTimer.unref();

  // ═══════════════════════════════════════════
  // 9. 启动 Bot
  // ═══════════════════════════════════════════
  await bot.launch();
  logger.info('[BOOT] Bot 已启动');

  // ═══════════════════════════════════════════
  // 10. SYSTEM_READY
  // ═══════════════════════════════════════════
  logger.info('═══════════════════════════════════════');
  logger.info('  TG 群监听下注系统已就绪 (SYSTEM_READY)');
  logger.info(`  环境: ${config.nodeEnv}`);
  logger.info(`  活跃 Session: ${sessionManager.getActiveCount()}`);
  logger.info(`  启用规则: ${enabledRules.length}`);
  logger.info('═══════════════════════════════════════');
  logger.audit('SYSTEM_READY', {
    activeSessions: sessionManager.getActiveCount(),
    enabledRules: enabledRules.length,
  });

  // ── 优雅关闭 ──
  const shutdown = async (signal) => {
    logger.info(`[BOOT] 收到 ${signal} 信号，开始优雅关闭...`);
    logger.audit('SYSTEM_SHUTDOWN', { signal });

    clearInterval(refreshTimer);
    clearInterval(cleanupTimer);
    clearInterval(pendingSweepTimer);
    dicePoller.stop();

    // 停止 Bot
    bot.stop(signal);

    // 销毁所有 Session
    await sessionManager.destroyAll();

    // 关闭数据库
    closeDb();

    // 关闭日志
    logger.close();

    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // 未捕获异常处理
  process.on('uncaughtException', (error) => {
    logger.error(`[BOOT] 未捕获异常: ${error.message}`, error);
    logger.audit('UNCAUGHT_EXCEPTION', { error: error.message, stack: error.stack });
  });

  process.on('unhandledRejection', (reason) => {
    logger.error(`[BOOT] 未处理的 Promise 拒绝: ${reason}`);
    logger.audit('UNHANDLED_REJECTION', { reason: String(reason) });
  });
}

/**
 * 生成北京时间偏移量时间字符串（与 SQLite datetime('now','+8 hours') 存储格式对齐）
 * @param {number} days - 相对今天的偏移天数（负数为过去）
 * @returns {string} 'YYYY-MM-DD HH:mm:ss'
 */
function beijingOffset(days) {
  const shifted = new Date(Date.now() + 8 * 3600 * 1000 + days * 24 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} 00:00:00`;
}

// ── 启动 ──
main().catch((error) => {
  console.error('[BOOT] 启动失败:', error);
  if (logger._initialized) {
    logger.error(`[BOOT] 启动失败: ${error.message}`, error);
  }
  process.exit(1);
});
