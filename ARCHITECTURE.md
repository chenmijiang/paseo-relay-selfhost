# Architecture

This server is a faithful port of paseo's `packages/relay/src/cloudflare-adapter.ts`. Key correspondences:

- Cloudflare keys sockets by Durable Object hibernation tags(`getWebSockets("server-control")`, `getWebSockets("client:" + id)`, …). Here those become in-memory `Map`/`Set` collections in `RelaySession`. No hibernation means we also drop per-socket attachment serialization and just close over `role`/`connectionId` in the event listeners.

- Each `relay-v{version}:{serverId}` gets its own `RelaySession`, mirroring the version-isolated DO instances.

- v2 control/data/client roles, the `sync`/`connected`/`disconnected` control messages, frame buffering until the daemon's data socket connects, the half-open-control nudge/reset, and the legacy v1 single-pair path are all reproduced.

- WebSocket protocol pings (the daemon's keepalive) are answered automatically by the `ws` library, so the hibernation-era JSON `ping`/`pong` keepalive is only kept for old daemons.
