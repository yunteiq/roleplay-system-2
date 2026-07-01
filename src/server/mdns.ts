import { Bonjour } from "bonjour-service";
import { log, errMsg } from "./log.ts";
import { lanIPv4s } from "./tls.ts";

/**
 * Advertise this server over mDNS/Bonjour as `_roleplay._tcp` so the H4 gesture
 * remote can discover it on the LAN (via Android's NsdManager) without a
 * hardcoded IP. The TXT record carries the scheme and the H4 event path so the
 * device knows exactly where to POST.
 *
 * The type is kept to <=15 chars per RFC 6763 (Android's NsdManager can reject
 * longer types) and must match the H4 app's discovery target. Best-effort: any
 * failure is logged and ignored (the H4 can still use a static URL).
 */
export function advertiseH4Discovery(port: number, scheme: string): void {
  try {
    const bonjour = new Bonjour();
    const ip = lanIPv4s()[0];
    const service = bonjour.publish({
      name: "Roleplay Director",
      // Resolves to `_roleplay._tcp` (matches the H4 firmware's SERVICE_TYPE).
      type: "roleplay",
      port,
      txt: { scheme, path: "/api/h4/event", ...(ip ? { ip } : {}) },
    });
    service.on("error", (err: Error) => log.warn(`mDNS advertisement error: ${errMsg(err)}`));
    log.info(`mDNS: advertising _roleplay._tcp on :${port} (H4 auto-discovery)`);

    const shutdown = () => {
      try {
        service.stop(() => bonjour.destroy());
      } catch {
        /* ignore */
      }
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (e) {
    log.warn(`mDNS: could not advertise (${errMsg(e)}); point the H4 at a static URL instead`);
  }
}
