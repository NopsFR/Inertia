// PM2 process configuration for the Inertia VPS deployment.
//
//   pm2 start ecosystem.config.js         # start web + bots
//   pm2 save && pm2 startup               # persist across reboots
//   pm2 logs / pm2 restart all / pm2 status
//
// The web app (server.js) and the Discord bot launcher run as two separate
// processes so a bot crash can never take the website down, and vice-versa.
module.exports = {
  apps: [
    {
      name: 'inertia-web',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/web-out.log',
      error_file: './logs/web-err.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'inertia-bots',
      script: 'bots/launcher.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 15,
      min_uptime: '10s',
      max_memory_restart: '384M',
      // Give Discord a moment before restarting on reconnect storms.
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/bots-out.log',
      error_file: './logs/bots-err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
