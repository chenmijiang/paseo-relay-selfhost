# paseo-relay-selfhost

[English](README.md) | **简体中文**

一个自托管、低延迟的 paseo 官方中继(`relay.paseo.sh`)平替。官方中继跑在 Cloudflare 的边缘网络上，从中国大陆等部分地区访问会绕路出境，访问会很慢。本项目则在你附近的 VPS 上用 Node.js + `ws` 跑同一套 wire 协议，守护进程和 App 都不用改。

## 部署

### Docker

```bash
RELAY_PORT=8787 docker compose up -d --build

curl localhost:8787/health   # -> {"status":"ok","sessions":0}
```

### PM2

用进程管理器直接跑在宿主机上:

```bash
npm ci && npm run build

pm2 start ecosystem.config.cjs

pm2 save && pm2 startup   # 重启后自动拉起 —— 执行它打印出的命令

pm2 logs paseo-relay   # 实时查看日志

pm2 restart paseo-relay   # 重新构建后
```

## 让守护进程指向它

守护进程读取下面这些环境变量。把它指向你中继的 `host:port`:

```bash
PASEO_RELAY_ENABLED=true \
PASEO_RELAY_ENDPOINT=relay.example.com:8787 \
paseo daemon start
```

`PASEO_RELAY_ENDPOINT` 是 `host:port`，不带 TLS 时就是 `:8787`。自托管端点默认走明文 `ws://`，所以除非你在中继前面加了 TLS，否则别开它；真加了，就设 `PASEO_RELAY_USE_TLS=true`，并把端口换成 TLS 的(`relay.example.com:443`)。

**有个坑: 启动/重启记得重新配对手机。** 中继地址被写死在配对二维码里，已有的配对还指向旧中继。重新扫一次码，App 才知道你的新中继。

想持久化、不走环境变量的话，在 `$PASEO_HOME/config.json` 里设 `daemon.relay`:

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

- `enabled` / `endpoint` 对应 `PASEO_RELAY_ENABLED` / `PASEO_RELAY_ENDPOINT`。
- 仅当你在中继前面加了 TLS，才加上 `"useTls": true`(即 `PASEO_RELAY_USE_TLS=true` 的持久化形式)，并把 `endpoint` 指向 TLS 端口。

## 配置

| 变量                       | 默认值      | 含义                                                                |
| -------------------------- | ----------- | ------------------------------------------------------------------- |
| `RELAY_HOST`               | `127.0.0.1` | 绑定地址(Docker 设为 `0.0.0.0`；本地 `npm start` 时为 localhost)。  |
| `RELAY_PORT`               | `8787`      | 中继对外暴露的端口(Docker:发布的宿主机端口；`npm start`:绑定端口)。 |
| `RELAY_ALLOWED_SERVER_IDS` | _(未设置)_  | 允许使用该中继的守护进程 `serverId`，逗号分隔。不设 = 开放中继。    |

`docker compose up` 和 PM2 配置都会把中继发布到宿主机的所有网络接口，所以任何能连到这台机器的人都能访问它。用防火墙和/或 `RELAY_ALLOWED_SERVER_IDS` 把它锁起来: 没有白名单时，任何发现你 URL 的人都能借你的机器转发自己的流量(E2EE 仍然保护内容，但他们会占用你的带宽)。你的 `serverId` 在配对界面就能找到。

## 工作原理

中继是一个**零知识桥**。你的守护进程(在防火墙后)主动**向外**连到中继，App 也连到同一个中继，中继在两者之间转发字节。它**从不解密任何东西**:守护进程和 App 通过这条管道跑一条端到端加密通道(Curve25519 + XSalsa20-Poly1305)，所以哪怕是恶意中继，也只看得到密文和路由元数据(哪个 `serverId`/`connectionId` 跟哪个通了信)。服务端本身**不含任何加密逻辑**，只做纯粹的帧转发。

正因为是端到端加密，中继跑在明文 `ws://` 上也没问题，不会泄露你的内容；TLS 可选——只在你想隐藏路由元数据、或要给 App 的 HTTPS web 版提供服务时才自己在前面加(浏览器不允许 HTTPS 页面连 `ws://`)。

paseo 的官方中继跑在 Cloudflare Workers + Durable Objects 上。本服务是 paseo `packages/relay/src/cloudflare-adapter.ts` 的移植；Cloudflare / Durable-Object 模型如何映射到本服务，见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 许可证

MIT
