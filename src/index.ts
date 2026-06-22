import { createRelayServer } from "./server.js";
import { createLogger } from "./logger.js";

const host = process.env.RELAY_HOST ?? "127.0.0.1";
const port = Number(process.env.RELAY_PORT ?? "8787");

const allowed = (process.env.RELAY_ALLOWED_SERVER_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const allowedServerIds = allowed.length > 0 ? new Set(allowed) : null;

const logger = createLogger();

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  logger.error(`Invalid RELAY_PORT: ${process.env.RELAY_PORT}`);
  process.exit(1);
}

const server = createRelayServer({ host, port, logger, allowedServerIds });

await server.listen();
logger.info(
  `paseo relay listening on ws://${host}:${port}/ws` +
    ` (serverId allowlist: ${allowedServerIds ? [...allowedServerIds].join(", ") : "off"})`,
);

const shutdown = async (signal: string): Promise<void> => {
  logger.info(`Received ${signal}, shutting down`);
  await server.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
