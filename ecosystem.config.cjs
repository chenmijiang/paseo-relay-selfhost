// PM2 process config — run the relay directly on a VPS.
//
//   npm ci && npm run build
//   pm2 start ecosystem.config.cjs   # start
//   pm2 save && pm2 startup          # survive reboots (run the printed command)
//
// Override env in the shell before `pm2 start`, or edit the `env` block below.
module.exports = {
  apps: [
    {
      name: "paseo-relay",
      script: "dist/index.js",
      // fork + a single instance is REQUIRED, not a default: the relay keeps
      // its session-pairing table in process memory, so cluster mode (multiple
      // workers) would scatter the two ends of a pair across processes and
      // break routing — the same reason this can't run serverless.
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
        // 0.0.0.0 so the relay is reachable on the host's public/LAN interface;
        // the code default (127.0.0.1) only accepts local connections. Lock the
        // port down with a firewall and/or RELAY_ALLOWED_SERVER_IDS.
        RELAY_HOST: "0.0.0.0",
        RELAY_PORT: "8787",
        RELAY_ALLOWED_SERVER_IDS: "",
      },
    },
  ],
};
