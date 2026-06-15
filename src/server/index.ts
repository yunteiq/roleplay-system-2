import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { resolve, join } from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.ts";
import { log, errMsg } from "./log.ts";
import { getTlsMaterial, lanIPv4s } from "./tls.ts";
import { validateProviderKeys } from "./providers/clients.ts";
import { Hub } from "./hub.ts";

function isFatalListenError(e: unknown): e is NodeJS.ErrnoException {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === "EADDRINUSE" || code === "EACCES" || code === "EADDRNOTAVAIL";
}

function reportListenError(e: NodeJS.ErrnoException): never {
  const cfg = loadConfig();
  if (e.code === "EADDRINUSE") {
    log.error(
      `Port ${cfg.port} is already in use on ${cfg.host}. ` +
        "Another process is bound to it (possibly another copy of this app). " +
        "Change PORT in your .env (e.g. PORT=8788) or stop the other process.",
    );
  } else if (e.code === "EACCES") {
    log.error(`Permission denied binding ${cfg.host}:${cfg.port}. Use a port >= 1024.`);
  } else {
    log.error(`Cannot bind ${cfg.host}:${cfg.port}: ${errMsg(e)}`);
  }
  process.exit(1);
}

// Bind failures should exit cleanly; provider/runtime failures must never crash.
process.on("uncaughtException", (e) => {
  if (isFatalListenError(e)) reportListenError(e);
  log.error("uncaughtException:", errMsg(e));
});
process.on("unhandledRejection", (e) => log.error("unhandledRejection:", errMsg(e)));

async function main(): Promise<void> {
  const cfg = loadConfig();
  validateProviderKeys();

  const publicDir = resolve("public");
  const app = express();
  app.disable("x-powered-by");
  app.use(express.static(publicDir, { index: "index.html" }));
  // SPA fallback: serve the app shell for any other GET.
  app.use((_req, res) => {
    res.sendFile(join(publicDir, "index.html"));
  });

  const secure = !cfg.insecureHttp;
  const server = secure
    ? createHttpsServer(await getTlsMaterial(cfg), app)
    : createHttpServer(app);

  const wss = new WebSocketServer({ server, path: "/ws", perMessageDeflate: false });
  const hub = new Hub();
  wss.on("connection", (ws, req) => {
    try {
      hub.handleConnection(ws, req);
    } catch (e) {
      log.error("connection error:", errMsg(e));
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  });

  server.on("error", (e: NodeJS.ErrnoException) => {
    if (isFatalListenError(e)) reportListenError(e);
    log.error("http server error:", errMsg(e));
  });

  server.listen(cfg.port, cfg.host, () => {
    const scheme = secure ? "https" : "http";
    const ips = lanIPv4s();
    log.info(`Live NPC roleplay server (${scheme.toUpperCase()})`);
    log.info("Open on this machine:");
    log.info(`   ${scheme}://localhost:${cfg.port}`);
    if (ips.length) {
      log.info("Open on other laptops (same Wi-Fi/LAN):");
      for (const ip of ips) log.info(`   ${scheme}://${ip}:${cfg.port}`);
    }
    if (secure) {
      log.info("Self-signed cert: accept the browser warning once per device.");
    } else {
      log.warn("INSECURE_HTTP: mic only works on localhost or behind an HTTPS proxy/tunnel.");
    }
    if (!cfg.openaiApiKey) {
      log.warn("OPENAI_API_KEY is missing — set it in .env to enable STT/dialogue/TTS.");
    }
  });
}

main().catch((e) => {
  log.error("fatal:", errMsg(e));
  process.exitCode = 1;
});
