// ecosystem.config.js — PM2 进程编排（与 pc28 同构）
module.exports = {
  apps: [{
    // 应用名称（用于 pm2 命令）
    name: 'tz',

    // 启动脚本
    script: './src/index.js',

    // 实例数（必须为 1，多实例会导致 Session 冲突）
    instances: 1,

    // 崩溃自动重启
    autorestart: true,

    // 监听文件变化（生产环境关闭）
    watch: false,

    // 最大内存限制（超过后自动重启）
    max_memory_restart: '500M',

    // 重启延迟（毫秒）
    restart_delay: 3000,

    // 最大重启次数（超过后停止重启）
    max_restarts: 10,

    // 日志配置
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,

    // 环境变量
    env: {
      NODE_ENV: 'production',
      TZ: 'Asia/Shanghai'
    },

    // 开发环境变量（pm2 start ecosystem.config.js --env development）
    env_development: {
      NODE_ENV: 'development',
      LOG_LEVEL: 'debug',
      TZ: 'Asia/Shanghai'
    }
  }]
};
