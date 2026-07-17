// pm2 process definition for seedaodb. Scoped to this directory only -- it is never merged
// into the host project's own pm2/supervisor configuration (configs/agents.json, etc.).
//
// Usage:
//   cd tools/seedaodb
//   cargo build --release
//   pm2 start ecosystem.config.cjs
//   pm2 logs seedaodb
//
// Changing `.env` requires `pm2 restart seedaodb --update-env` (or a fresh `pm2 start`) -- pm2
// does not reload environment variables on a plain restart.
module.exports = {
  apps: [
    {
      name: 'seedaodb',
      script: './target/release/seedaodb',
      interpreter: 'none',
      cwd: __dirname,
      autorestart: true,
      watch: false,
    },
  ],
};
