/**
 * PM2 ecosystem config for the Expensee keeper service.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs keeper
 *   pm2 monit
 *   pm2 restart keeper
 */
module.exports = {
  apps: [
    {
      name: 'keeper',
      script: 'npx',
      args: 'ts-node src/index.ts',
      cwd: __dirname,
      // Load .env automatically
      env_file: '.env',
      // Restart on crash
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      // Watch for code changes (disable in production)
      watch: false,
      // Logs
      out_file: 'logs/keeper-out.log',
      error_file: 'logs/keeper-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // Memory limit: restart if exceeds 512MB
      max_memory_restart: '512M',
    },
  ],
};
