import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { RelaySession, type ConnectionRole, type RelayProtocolVersion } from "./relay-session.js";
import type { Logger } from "./logger.js";

export interface RelayServerOptions {
  host: string;
  port: number;
  logger: Logger;
  /**
   * If set, only these daemon serverIds may use this relay. Locks a personal
   * relay to your own daemon(s) so strangers can't route traffic through your
   * box. Unset = open relay (still zero-knowledge, but anyone may use it).
   */
  allowedServerIds?: Set<string> | null;
}

export interface RelayServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  sessionCount(): number;
  /** Actual bound port, available after listen() resolves. Null before that. */
  port(): number | null;
}

export function createRelayServer(opts: RelayServerOptions): RelayServer {
  const { logger } = opts;
  const allowedServerIds = opts.allowedServerIds ?? null;

  // One session per `relay-v{version}:{serverId}`, mirroring the version-isolated
  // Durable Object instances in the Cloudflare relay.
  const sessions = new Map<string, RelaySession>();
  const removeSession = (key: string): void => {
    sessions.delete(key);
  };
  const getSession = (key: string): RelaySession => {
    let session = sessions.get(key);
    if (!session) {
      session = new RelaySession(key, logger, removeSession);
      sessions.set(key, session);
    }
    return session;
  };

  const wss = new WebSocketServer({ noServer: true });

  const httpServer: Server = createServer((req, res) => {
    if (req.url && req.url.split("?")[0] === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", sessions: sessions.size }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = safeParseUrl(req);
    if (!url || url.pathname !== "/ws") {
      return reject(socket, 404, "Not found");
    }

    const roleRaw = url.searchParams.get("role");
    const role: ConnectionRole | null =
      roleRaw === "server" || roleRaw === "client" ? roleRaw : null;
    const serverId = url.searchParams.get("serverId");
    const version = resolveVersion(url.searchParams.get("v"));
    const connectionId = (url.searchParams.get("connectionId") ?? "").trim();

    if (!role) return reject(socket, 400, "Missing or invalid role parameter");
    if (!serverId) return reject(socket, 400, "Missing serverId parameter");
    if (!version) return reject(socket, 400, "Invalid v parameter (expected 1 or 2)");
    if (allowedServerIds && !allowedServerIds.has(serverId)) {
      logger.warn(`Rejected connection: serverId not in allowlist (${serverId})`);
      return reject(socket, 403, "Forbidden serverId");
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const key = `relay-v${version}:${serverId}`;
      const session = getSession(key);
      if (version === "1") {
        session.acceptV1(ws, role);
      } else {
        session.acceptV2(ws, role, connectionId);
      }
    });
  });

  return {
    listen: () =>
      new Promise<void>((resolve) => {
        httpServer.listen(opts.port, opts.host, () => resolve());
      }),
    close: () =>
      new Promise<void>((resolve) => {
        wss.close();
        httpServer.close(() => resolve());
      }),
    sessionCount: () => sessions.size,
    port: () => {
      const addr = httpServer.address();
      return addr && typeof addr === "object" ? addr.port : null;
    },
  };
}

function safeParseUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    return null;
  }
}

/**
 * Mirrors the Cloudflare adapter: a missing/empty `v` means legacy v1; an
 * unrecognized value is an error. Current daemons always send `v=2`.
 */
function resolveVersion(raw: string | null): RelayProtocolVersion | null {
  if (raw == null) return "1";
  const value = raw.trim();
  if (!value) return "1";
  if (value === "1" || value === "2") return value;
  return null;
}

function reject(socket: Duplex, code: number, message: string): void {
  try {
    socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\n\r\n`);
  } catch {
    // ignore
  }
  socket.destroy();
}
