// src/utils/config.loader.js
const path = require('path');
const fs = require('fs');

/**
 * 配置加载器
 *
 * 必填项：
 *   BOT_TOKEN    - Telegram Bot Token
 *   TG_API_ID    - Telegram API ID（兼容 API_ID 写法）
 *   TG_API_HASH  - Telegram API Hash（兼容 API_HASH 写法）
 *
 * 可选项（有默认值）：
 *   DATABASE_PATH          - 数据库路径（默认 ./data/database.db）
 *   LOG_LEVEL              - 日志级别（默认 info）
 *   LOG_DIR                - 日志目录（默认 ./logs）
 *   NODE_ENV               - 运行环境（默认 production）
 *   MESSAGE_RETENTION_DAYS - 消息流水保留天数（默认 90）
 *   ACTION_RETENTION_DAYS  - 动作记录保留天数（默认 180）
 *   DICE_POLL_INTERVAL_MS  - 开奖轮询间隔（默认 5000）
 *   LOG_CONSOLE            - 日志是否打印到终端（默认 false，只写日志文件）
 *   BALANCE_NICKNAME       - 本账号在群里的下注昵称（可选，余额播报归属二次校验）
 */

// 加载 .env（如果存在）
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

// 兼容旧 .env 的变量名（API_ID / API_HASH）
const API_ID_KEY = process.env.TG_API_ID ? 'TG_API_ID' : (process.env.API_ID ? 'API_ID' : 'TG_API_ID');
const API_HASH_KEY = process.env.TG_API_HASH ? 'TG_API_HASH' : (process.env.API_HASH ? 'API_HASH' : 'TG_API_HASH');

/**
 * 必填配置项
 */
const REQUIRED_KEYS = ['BOT_TOKEN', API_ID_KEY, API_HASH_KEY];

/**
 * 配置默认值
 */
const DEFAULTS = {
  DATABASE_PATH: './data/database.db',
  LOG_LEVEL: 'info',
  LOG_DIR: './logs',
  NODE_ENV: 'production',
  MESSAGE_RETENTION_DAYS: '90',
  ACTION_RETENTION_DAYS: '180',
  DICE_POLL_INTERVAL_MS: '5000',
  // 控制台日志开关：默认关闭（日志只写文件，终端保持干净）
  LOG_CONSOLE: 'false',
  // 本账号在群里下注时显示的昵称（可选）：余额播报里必须出现它才认领余额
  BALANCE_NICKNAME: '',
};

/**
 * 加载并校验配置
 *
 * @returns {object} 配置对象
 * @throws {Error} 缺少必填配置时抛出
 */
function loadConfig() {
  const missing = [];

  // 校验必填项
  for (const key of REQUIRED_KEYS) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `缺少必填环境变量: ${missing.join(', ')}\n` +
      `请在 .env 文件中配置`
    );
  }

  // 合并默认值
  const config = {
    // 必填
    botToken: process.env.BOT_TOKEN,
    tgApiId: parseInt(process.env[API_ID_KEY], 10),
    tgApiHash: process.env[API_HASH_KEY],

    // 可选（带默认值）
    databasePath: process.env.DATABASE_PATH || DEFAULTS.DATABASE_PATH,
    logLevel: process.env.LOG_LEVEL || DEFAULTS.LOG_LEVEL,
    logDir: process.env.LOG_DIR || DEFAULTS.LOG_DIR,
    nodeEnv: process.env.NODE_ENV || DEFAULTS.NODE_ENV,
    messageRetentionDays: parseInt(
      process.env.MESSAGE_RETENTION_DAYS || DEFAULTS.MESSAGE_RETENTION_DAYS,
      10
    ),
  actionRetentionDays: parseInt(
    process.env.ACTION_RETENTION_DAYS || DEFAULTS.ACTION_RETENTION_DAYS,
    10
  ),
  dicePollIntervalMs: parseInt(
    process.env.DICE_POLL_INTERVAL_MS || DEFAULTS.DICE_POLL_INTERVAL_MS,
    10
  ),
  // 终端日志开关：LOG_CONSOLE=true 才往终端打印，否则只写日志文件
  logConsole: String(process.env.LOG_CONSOLE || DEFAULTS.LOG_CONSOLE).toLowerCase() === 'true',
  // 余额播报昵称校验（空 = 不校验，仅靠 reply 归属）
  balanceNickname: (process.env.BALANCE_NICKNAME || DEFAULTS.BALANCE_NICKNAME).trim(),
};

  // 校验 TG_API_ID 为数字
  if (isNaN(config.tgApiId)) {
    throw new Error(`${API_ID_KEY} 必须为数字`);
  }

  return config;
}

/**
 * 获取配置（单例缓存）
 * @returns {object}
 */
let _cachedConfig = null;
function getConfig() {
  if (!_cachedConfig) {
    _cachedConfig = loadConfig();
  }
  return _cachedConfig;
}

/**
 * 获取单个配置项
 * @param {string} key
 * @returns {*}
 */
function get(key) {
  return getConfig()[key];
}

/**
 * 判断是否为生产环境
 * @returns {boolean}
 */
function isProduction() {
  return getConfig().nodeEnv === 'production';
}

/**
 * 判断是否为开发环境
 * @returns {boolean}
 */
function isDevelopment() {
  return getConfig().nodeEnv === 'development';
}

module.exports = {
  loadConfig,
  getConfig,
  get,
  isProduction,
  isDevelopment,
};
