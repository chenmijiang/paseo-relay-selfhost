import { randomUUID } from "node:crypto";
import type { RawData, WebSocket } from "ws";
import type { Logger } from "./logger.js";

export type ConnectionRole = "server" | "client";
export type RelayProtocolVersion = "1" | "2";

type Sendable = RawData | string;
type PendingFrame = { data: RawData; isBinary: boolean };

const NUDGE_INITIAL_DELAY_MS = 10_000;
const NUDGE_SECOND_DELAY_MS = 5_000;
const MAX_PENDING_FRAMES = 200;

/**
 * One RelaySession owns all sockets for a single (version, serverId) pair — the
 * Node analogue of a single RelayDurableObject instance in paseo's Cloudflare
 * port. The protocol is identical; only the substrate differs:
 *
 *   - Cloudflare keys sockets by hibernation tags (`getWebSockets(tag)`).
 *     We key them by plain in-memory Maps/Sets. No hibernation, so we can also
 *     drop the per-socket attachment serialization and just close over role /
 *     connectionId in the event listeners.
 *
 * The relay is ZERO-KNOWLEDGE: it never decrypts. It forwards opaque frames
 * between the daemon (role=server) and clients (role=client). All real security
 * lives in the end-to-end encrypted channel the two peers negotiate through this
 * pipe, so a hostile or compromised relay only ever sees ciphertext plus routing
 * metadata (which serverId/connectionId talked to which).
 *
 * v2 topology (current daemons):
 *   - role=server, no connectionId      -> daemon control socket (one per serverId)
 *   - role=server, connectionId=X       -> daemon per-connection data socket
 *   - role=client, connectionId=X       -> app socket (many allowed per X)
 *
 * v1 topology (legacy daemons): a single server/client pair, forwarded by
 * opposite role. Kept for compatibility; new daemons never use it.
 */
export class RelaySession {
  // v2 — daemon control sockets (normally exactly one; we tolerate transient extras)
  private readonly controlSockets = new Set<WebSocket>();
  // v2 — daemon per-connection data sockets: connectionId -> socket
  private readonly dataSockets = new Map<string, WebSocket>();
  // v2 — app sockets: connectionId -> set of sockets
  private readonly clientSockets = new Map<string, Set<WebSocket>>();
  // v2 — frames buffered until the matching daemon data socket connects
  private readonly pendingFrames = new Map<string, PendingFrame[]>();

  // v1 — legacy single-pair forwarding
  private readonly v1Servers = new Set<WebSocket>();
  private readonly v1Clients = new Set<WebSocket>();

  constructor(
    private readonly key: string,
    private readonly logger: Logger,
    private readonly onEmpty: (key: string) => void,
  ) {}

  // --- v1 (legacy) ---------------------------------------------------------

  acceptV1(ws: WebSocket, role: ConnectionRole): void {
    const bucket = role === "server" ? this.v1Servers : this.v1Clients;
    // A new socket for a role replaces the old one (matches the Cloudflare port).
    for (const existing of bucket) {
      try {
        existing.close(1008, "Replaced by new connection");
      } catch {
        // ignore
      }
    }
    bucket.clear();
    bucket.add(ws);

    ws.on("message", (data: RawData, isBinary: boolean) => {
      const targets = role === "server" ? this.v1Clients : this.v1Servers;
      for (const target of targets) this.safeSend(target, data, isBinary);
    });
    ws.on("close", () => {
      bucket.delete(ws);
      this.maybeEmpty();
    });
    ws.on("error", (err: Error) => {
      this.logger.warn(`v1:${role} socket error on ${this.key}: ${err.message}`);
    });

    this.logger.info(`v1:${role} connected to ${this.key}`);
  }

  // --- v2 ------------------------------------------------------------------

  acceptV2(ws: WebSocket, role: ConnectionRole, rawConnectionId: string): void {
    // If a client omits connectionId, the relay assigns one for routing.
    const connectionId =
      role === "client" && !rawConnectionId
        ? `conn_${randomUUID().replace(/-/g, "").slice(0, 16)}`
        : rawConnectionId;

    const isServerControl = role === "server" && !connectionId;
    const isServerData = role === "server" && !!connectionId;

    // A new server-side socket replaces any existing one with the same identity.
    // Multiple client sockets per connectionId are allowed.
    if (isServerControl) {
      for (const existing of this.controlSockets) {
        try {
          existing.close(1008, "Replaced by new connection");
        } catch {
          // ignore
        }
      }
      this.controlSockets.clear();
    } else if (isServerData) {
      const existing = this.dataSockets.get(connectionId);
      if (existing) {
        try {
          existing.close(1008, "Replaced by new connection");
        } catch {
          // ignore
        }
      }
    }

    // Register the socket.
    if (role === "client") {
      let set = this.clientSockets.get(connectionId);
      if (!set) {
        set = new Set();
        this.clientSockets.set(connectionId, set);
      }
      set.add(ws);
    } else if (isServerControl) {
      this.controlSockets.add(ws);
    } else {
      this.dataSockets.set(connectionId, ws);
    }

    ws.on("message", (data: RawData, isBinary: boolean) =>
      this.handleV2Message(role, connectionId, data, isBinary, ws),
    );
    ws.on("close", (code: number, reason: Buffer) =>
      this.handleV2Close(role, connectionId, ws, code, reason.toString()),
    );
    ws.on("error", (err: Error) => {
      this.logger.warn(`v2:${role} socket error on ${this.key}: ${err.message}`);
    });

    // Post-connect coordination.
    if (role === "client") {
      this.notifyControls({ type: "connected", connectionId });
      this.nudgeOrResetControlForConnection(connectionId);
    }
    if (isServerControl) {
      // Hand the daemon the current connection list so it can (re)attach.
      this.safeSend(
        ws,
        JSON.stringify({ type: "sync", connectionIds: this.listConnectedConnectionIds() }),
        false,
      );
    }
    if (isServerData) {
      this.flushFrames(connectionId, ws);
    }

    const label = isServerControl ? "(control)" : connectionId ? `(${connectionId})` : "";
    this.logger.info(`v2:${role}${label} connected to ${this.key}`);
  }

  private handleV2Message(
    role: ConnectionRole,
    connectionId: string,
    data: RawData,
    isBinary: boolean,
    ws: WebSocket,
  ): void {
    if (!connectionId) {
      // Control channel: support the legacy app-level JSON keepalive. Modern
      // daemons use WebSocket protocol pings, which `ws` auto-answers with pongs.
      if (!isBinary) this.handleControlKeepalive(ws, data);
      return;
    }

    if (role === "client") {
      const dataSocket = this.dataSockets.get(connectionId);
      if (!dataSocket) {
        // Daemon hasn't opened its data socket yet — buffer until it does.
        this.bufferFrame(connectionId, data, isBinary);
        return;
      }
      this.safeSend(dataSocket, data, isBinary);
      return;
    }

    // Daemon data socket -> every app socket on this connection.
    const clients = this.clientSockets.get(connectionId);
    if (clients) {
      for (const client of clients) this.safeSend(client, data, isBinary);
    }
  }

  private handleV2Close(
    role: ConnectionRole,
    connectionId: string,
    ws: WebSocket,
    code: number,
    reason: string,
  ): void {
    const label = connectionId ? `(${connectionId})` : "(control)";
    this.logger.info(`v2:${role}${label} disconnected from ${this.key} (${code} ${reason})`);

    if (role === "client" && connectionId) {
      const set = this.clientSockets.get(connectionId);
      if (set) {
        set.delete(ws);
        if (set.size > 0) {
          // Other tabs/sockets on this connection are still live.
          this.maybeEmpty();
          return;
        }
        this.clientSockets.delete(connectionId);
      }
      this.pendingFrames.delete(connectionId);
      // Last client for this connection left: tear down the daemon data socket.
      const dataSocket = this.dataSockets.get(connectionId);
      if (dataSocket) {
        try {
          dataSocket.close(1001, "Client disconnected");
        } catch {
          // ignore
        }
      }
      this.notifyControls({ type: "disconnected", connectionId });
      this.maybeEmpty();
      return;
    }

    if (role === "server" && connectionId) {
      if (this.dataSockets.get(connectionId) === ws) {
        this.dataSockets.delete(connectionId);
      }
      // Force the app to reconnect and re-handshake when the daemon side drops:
      // the E2EE session state is gone, so the old channel can't continue.
      const clients = this.clientSockets.get(connectionId);
      if (clients) {
        for (const client of clients) {
          try {
            client.close(1012, "Server disconnected");
          } catch {
            // ignore
          }
        }
      }
      this.maybeEmpty();
      return;
    }

    // Control socket closed.
    this.controlSockets.delete(ws);
    this.maybeEmpty();
  }

  // --- helpers -------------------------------------------------------------

  private handleControlKeepalive(ws: WebSocket, data: RawData): void {
    try {
      const parsed: unknown = JSON.parse(rawToString(data));
      if (!isRecord(parsed) || parsed.type !== "ping") return;
      this.safeSend(ws, JSON.stringify({ type: "pong", ts: Date.now() }), false);
    } catch {
      // ignore non-JSON control payloads
    }
  }

  /**
   * If the daemon's control socket goes half-open, we can't always detect it via
   * send errors. Observe instead whether the daemon reacts to a new client by
   * opening the per-connection data socket; if it doesn't, nudge with a fresh
   * sync, then force-close control so the daemon reconnects.
   */
  private nudgeOrResetControlForConnection(connectionId: string): void {
    const first = setTimeout(() => {
      if (!this.hasClient(connectionId)) return;
      if (this.dataSockets.has(connectionId)) return;

      this.notifyControls({ type: "sync", connectionIds: this.listConnectedConnectionIds() });

      const second = setTimeout(() => {
        if (!this.hasClient(connectionId)) return;
        if (this.dataSockets.has(connectionId)) return;
        for (const ws of this.controlSockets) {
          try {
            ws.close(1011, "Control unresponsive");
          } catch {
            // ignore
          }
        }
      }, NUDGE_SECOND_DELAY_MS);
      second.unref();
    }, NUDGE_INITIAL_DELAY_MS);
    first.unref();
  }

  private bufferFrame(connectionId: string, data: RawData, isBinary: boolean): void {
    const frames = this.pendingFrames.get(connectionId) ?? [];
    frames.push({ data, isBinary });
    // Bound memory if a daemon never shows up to drain the buffer.
    if (frames.length > MAX_PENDING_FRAMES) {
      frames.splice(0, frames.length - MAX_PENDING_FRAMES);
    }
    this.pendingFrames.set(connectionId, frames);
  }

  private flushFrames(connectionId: string, serverWs: WebSocket): void {
    const frames = this.pendingFrames.get(connectionId);
    if (!frames || frames.length === 0) return;
    this.pendingFrames.delete(connectionId);
    for (const frame of frames) this.safeSend(serverWs, frame.data, frame.isBinary);
  }

  private notifyControls(message: unknown): void {
    const text = JSON.stringify(message);
    for (const ws of this.controlSockets) {
      try {
        ws.send(text);
      } catch {
        try {
          ws.close(1011, "Control send failed");
        } catch {
          // ignore
        }
      }
    }
  }

  private listConnectedConnectionIds(): string[] {
    const out: string[] = [];
    for (const [connectionId, set] of this.clientSockets) {
      if (set.size > 0) out.push(connectionId);
    }
    return out;
  }

  private hasClient(connectionId: string): boolean {
    const set = this.clientSockets.get(connectionId);
    return !!set && set.size > 0;
  }

  private safeSend(ws: WebSocket, data: Sendable, isBinary: boolean): void {
    try {
      ws.send(data, { binary: isBinary });
    } catch (err) {
      this.logger.warn(`forward failed on ${this.key}: ${(err as Error).message}`);
    }
  }

  private maybeEmpty(): void {
    if (
      this.controlSockets.size === 0 &&
      this.dataSockets.size === 0 &&
      this.clientSockets.size === 0 &&
      this.v1Servers.size === 0 &&
      this.v1Clients.size === 0
    ) {
      this.onEmpty(this.key);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function rawToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}
