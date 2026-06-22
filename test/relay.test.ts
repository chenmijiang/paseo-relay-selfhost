import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import { createRelayServer, type RelayServer } from "../src/server.js";

const silentLogger = { info() {}, warn() {}, error() {} };

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

/**
 * Buffers every inbound frame from the moment the socket is created, so tests
 * never lose a message that arrives before they get around to awaiting it. The
 * relay flushes buffered frames the instant a daemon data socket connects, so an
 * await-then-listen pattern would race against that flush.
 */
class MessageQueue {
  private readonly queued: string[] = [];
  private waiters: ((value: string) => void)[] = [];

  constructor(ws: WebSocket) {
    ws.on("message", (data: RawData) => {
      const text = data.toString();
      const waiter = this.waiters.shift();
      if (waiter) waiter(text);
      else this.queued.push(text);
    });
  }

  next(): Promise<string> {
    const queued = this.queued.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async nextJson(): Promise<Record<string, unknown>> {
    return JSON.parse(await this.next()) as Record<string, unknown>;
  }
}

describe("relay v2 forwarding", () => {
  let server: RelayServer;
  let base: string;

  beforeAll(async () => {
    server = createRelayServer({ host: "127.0.0.1", port: 0, logger: silentLogger });
    await server.listen();
    base = `ws://127.0.0.1:${server.port()}/ws`;
  });

  afterAll(async () => {
    await server.close();
  });

  it("routes client <-> daemon-data frames by connectionId, with buffering", async () => {
    const serverId = "S-route";

    // Daemon control socket (no connectionId).
    const control = new WebSocket(`${base}?role=server&serverId=${serverId}&v=2`);
    const controlMsgs = new MessageQueue(control);
    await waitOpen(control);
    expect((await controlMsgs.nextJson()).type).toBe("sync"); // sent on connect

    // Client connects without a connectionId -> relay assigns one, tells control.
    const client = new WebSocket(`${base}?role=client&serverId=${serverId}&v=2`);
    const clientMsgs = new MessageQueue(client);
    await waitOpen(client);
    const connected = await controlMsgs.nextJson();
    expect(connected.type).toBe("connected");
    const connectionId = connected.connectionId as string;
    expect(connectionId, "relay assigned a connectionId").toBeTruthy();

    // Client sends BEFORE the daemon data socket exists -> must be buffered.
    client.send("ciphertext-buffered");

    // Daemon opens the per-connection data socket; buffered frame should flush.
    const data = new WebSocket(
      `${base}?role=server&serverId=${serverId}&connectionId=${connectionId}&v=2`,
    );
    const dataMsgs = new MessageQueue(data);
    await waitOpen(data);
    expect(await dataMsgs.next()).toBe("ciphertext-buffered");

    // Live client -> daemon.
    client.send("ciphertext-live");
    expect(await dataMsgs.next()).toBe("ciphertext-live");

    // Daemon -> client.
    data.send("ciphertext-reply");
    expect(await clientMsgs.next()).toBe("ciphertext-reply");

    control.close();
    client.close();
    data.close();
  });

  it("rejects serverIds outside the allowlist", async () => {
    const guarded = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      logger: silentLogger,
      allowedServerIds: new Set(["allowed-only"]),
    });
    await guarded.listen();
    const url = `ws://127.0.0.1:${guarded.port()}/ws?role=server&serverId=intruder&v=2`;
    const ws = new WebSocket(url);
    await expect(waitOpen(ws)).rejects.toThrow();
    await guarded.close();
  });
});
