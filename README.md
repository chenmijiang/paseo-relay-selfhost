# paseo-relay-selfhost

**English** | [简体中文](README-ZH.md)

A self-hosted, low-latency drop-in for paseo's hosted relay (`relay.paseo.sh`). The official relay runs on Cloudflare's edge, which routes overseas (and slow) from some regions like mainland China — this runs the **same wire protocol** as a plain Node.js + `ws` server on a VPS near you. **The daemon and app need zero changes.**

## Deploy

### Docker

```bash
RELAY_PORT=8787 docker compose up -d --build

curl localhost:8787/health   # -> {"status":"ok","sessions":0}
```

### PM2

To run straight on the host under a process manager:

```bash
npm ci && npm run build

pm2 start ecosystem.config.cjs

pm2 save && pm2 startup   # survive reboots — run the command it prints

pm2 logs paseo-relay   # tail logs

pm2 restart paseo-relay   # after a rebuild
```

## Point your daemon at it

The daemon reads these env vars. Point it at your relay's `host:port`:

```bash
PASEO_RELAY_ENABLED=true \
PASEO_RELAY_ENDPOINT=relay.example.com:8787 \
paseo daemon start
```

`PASEO_RELAY_ENDPOINT` is `host:port` — the plain relay is `:8787`. Self-hosted endpoints default to plain `ws://`, so leave TLS off unless you front the relay with it; if you do, add `PASEO_RELAY_USE_TLS=true` and point at the TLS port instead (`relay.example.com:443`).

**One gotcha — re-pair your phone afterward.** The relay address is baked into the pairing QR code, so existing pairings still point at the old relay. Scan a fresh code once so the app learns your relay.

To persist instead of env vars, set `daemon.relay` in `$PASEO_HOME/config.json`:

```json
{
  "daemon": {
    "relay": {
      "enabled": true,
      "endpoint": "relay.example.com:8787"
    }
  }
}
```

- `enabled` / `endpoint` mirror `PASEO_RELAY_ENABLED` / `PASEO_RELAY_ENDPOINT`.
- Only if you front the relay with TLS, add `"useTls": true` (the persisted form
  of `PASEO_RELAY_USE_TLS=true`) and point `endpoint` at the TLS port.

## Configuration

| Variable                   | Default     | Meaning                                                                               |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| `RELAY_HOST`               | `127.0.0.1` | Bind address (Docker sets `0.0.0.0`; localhost for a local `npm start`).              |
| `RELAY_PORT`               | `8787`      | Port the relay is reachable on (Docker: published host port; `npm start`: bind port). |
| `RELAY_ALLOWED_SERVER_IDS` | _(unset)_   | Comma-separated daemon `serverId`s allowed to use this relay. Unset = open relay.     |

Both `docker compose up` and the PM2 config publish the relay on all host interfaces, so anyone who can reach the host can hit it. Lock it down with a firewall and/or `RELAY_ALLOWED_SERVER_IDS`: without the allow-list, anyone who discovers your URL can route their own traffic through your box (E2EE still protects content, but they'd use your bandwidth). Find your `serverId` on the pairing screen.

## How it works

The relay is a **zero-knowledge bridge**. Your daemon (behind a firewall) connects _outbound_ to the relay, the app connects to the same relay, and the relay forwards bytes between them. It **never decrypts anything**: the daemon and app run an end-to-end encrypted channel (Curve25519 + XSalsa20-Poly1305) through the pipe, so a hostile relay only ever sees ciphertext plus routing metadata (which `serverId`/`connectionId` talked to which). The server itself contains **no cryptography** — it is pure frame routing.

Because that channel is end-to-end encrypted, the relay works fine over plain `ws://` and never exposes your content; TLS is optional (add it yourself in front of the relay only to hide routing metadata, or to serve the app's HTTPS web build, which browsers forbid from talking `ws://`).

paseo's official relay runs on Cloudflare Workers + Durable Objects. This server is a faithful port of paseo's `packages/relay/src/cloudflare-adapter.ts`; see [ARCHITECTURE.md](ARCHITECTURE.md) for how the Cloudflare / Durable-Object model maps onto it.

## License

MIT
