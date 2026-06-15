import { networkInterfaces } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generate } from "selfsigned";
import { log } from "./log.ts";
import type { Config } from "./config.ts";

const CERT_DIR = ".cert";
const CERT_FILE = join(CERT_DIR, "cert.pem");
const KEY_FILE = join(CERT_DIR, "key.pem");
const META_FILE = join(CERT_DIR, "sans.json");

export interface TlsMaterial {
  cert: string;
  key: string;
}

/** Return all non-internal IPv4 addresses of this machine. */
export function lanIPv4s(): string[] {
  const out: string[] = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return [...new Set(out)];
}

/** Load a user-provided cert, a cached self-signed cert, or mint a new one. */
export async function getTlsMaterial(cfg: Config): Promise<TlsMaterial> {
  if (cfg.tlsCert && cfg.tlsKey) {
    log.info("TLS: using provided TLS_CERT / TLS_KEY");
    return {
      cert: readFileSync(cfg.tlsCert, "utf8"),
      key: readFileSync(cfg.tlsKey, "utf8"),
    };
  }

  const ips = lanIPv4s();
  const wantSans = JSON.stringify(["localhost", "127.0.0.1", "::1", ...ips].sort());

  if (existsSync(CERT_FILE) && existsSync(KEY_FILE) && existsSync(META_FILE)) {
    try {
      const haveSans = readFileSync(META_FILE, "utf8");
      if (haveSans === wantSans) {
        return {
          cert: readFileSync(CERT_FILE, "utf8"),
          key: readFileSync(KEY_FILE, "utf8"),
        };
      }
      log.info("TLS: LAN addresses changed, regenerating self-signed cert");
    } catch {
      // fall through to regenerate
    }
  }

  log.info("TLS: generating self-signed cert for", ["localhost", "127.0.0.1", ...ips].join(", "));

  const altNames = [
    { type: 2 as const, value: "localhost" },
    { type: 7 as const, ip: "127.0.0.1" },
    { type: 7 as const, ip: "::1" },
    ...ips.map((ip) => ({ type: 7 as const, ip })),
  ];

  const pems = await generate([{ name: "commonName", value: "localhost" }], {
    keySize: 2048,
    algorithm: "sha256",
    notAfterDate: new Date(Date.now() + 825 * 24 * 60 * 60 * 1000),
    extensions: [
      { name: "basicConstraints", cA: false },
      {
        name: "keyUsage",
        digitalSignature: true,
        keyEncipherment: true,
      },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames },
    ],
  });

  mkdirSync(CERT_DIR, { recursive: true });
  writeFileSync(CERT_FILE, pems.cert);
  writeFileSync(KEY_FILE, pems.private);
  writeFileSync(META_FILE, wantSans);

  return { cert: pems.cert, key: pems.private };
}
