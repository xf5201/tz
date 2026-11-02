// src/utils/logger.js
const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.loader');
const { formatDate } = require('./format.util');

/**
 * 获取本地时间字符串 (YYYY-MM-DD HH:mm:ss)
 */
function getLocalTime() {
  return formatDate(new Date(), 'YYYY-MM-DD HH:mm:ss');
}

// ── 日志级别 ──
const LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ── 日志级别颜色（控制台） ──
const LEVEL_COLORS = {
  debug: '\x1b[36m', // 青色
  info: '\x1b[32m',  // 绿色
  warn: '\x1b[33m',  // 黄色
  error: '\x1b[31m', // 红色
};
const RESET = '\x1b[0m';

/**
 * Logger 类
 */
class Logger {
  constructor() {
    this._initialized = false;
    this._streams = {};
    this._level = LEVELS.info;
    // 控制台输出开关：默认关闭（终端保持干净，日志一律写文件）
    this._console = false;
  }

  /**
   * 初始化日志系统
   */
  init() {
    if (this._initialized) return;

    try {
      const config = getConfig();
      const logDir = path.resolve(config.logDir);

      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      this._level = LEVELS[config.logLevel] ?? LEVELS.info;
      this._console = config.logConsole === true;

      this._streams = {
        app: fs.createWriteStream(path.join(logDir, 'app.log'), { flags: 'a' }),
        error: fs.createWriteStream(path.join(logDir, 'error.log'), { flags: 'a' }),
        audit: fs.createWriteStream(path.join(logDir, 'audit.log'), { flags: 'a' }),
      };

      this._initialized = true;
    } catch (error) {
      console.error('[LOGGER] 初始化失败，降级为控制台输出:', error.message);
      this._initialized = true;
    }
  }

  /**
   * 写入日志
   */
  _write(level, message, meta, streamKey = 'app') {
    if (LEVELS[level] < this._level) return;

    const line = `[${getLocalTime()}] [${level.toUpperCase()}] ${message}` +
      (meta ? ` ${JSON.stringify(meta)}` : '');

    // 控制台（带颜色）：仅 LOG_CONSOLE=true 时输出
    if (this._console) {
      const color = LEVEL_COLORS[level] || '';
      if (level === 'error') {
        console.error(`${color}${line}${RESET}`);
      } else if (level === 'warn') {
        console.warn(`${color}${line}${RESET}`);
      } else {
        console.log(`${color}${line}${RESET}`);
      }
    }

    // 文件
    const stream = this._streams[streamKey];
    if (stream) {
      stream.write(line + '\n');
    }
  }

  debug(message, meta) { this._write('debug', message, meta); }
  info(message, meta) { this._write('info', message, meta); }
  warn(message, meta) { this._write('warn', message, meta); }

  error(message, meta) {
    this._write('error', message, meta);
    this._write('error', message, meta, 'error');
  }

  /**
   * 审计日志（关键操作：登录/删除/规则变更/启停）
   */
  audit(action, meta) {
    this._write('info', `[AUDIT] ${action}`, meta, 'audit');
  }

  /**
   * 关闭日志（优雅停机）
   */
  close() {
    for (const key of Object.keys(this._streams)) {
      try { this._streams[key].end(); } catch (_) {}
    }
    this._streams = {};
  }
}

module.exports = new Logger();
