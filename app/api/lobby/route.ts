import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const DEV_SALT = "gesturedrop-dev-salt";

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "";
}

function expandIpv6(ip: string): string[] | null {
  const clean = ip.split("%")[0];
  const halves = clean.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":") : [];
  if (halves.length === 1) {
    return head.length === 8 ? head.map((p) => p.padStart(4, "0").toLowerCase()) : null;
  }

  const tail = halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array<string>(fill).fill("0"), ...tail].map((p) =>
    p.padStart(4, "0").toLowerCase()
  );
}

/**
 * Devices behind one router share a public IPv4 address, but each gets its own
 * IPv6 address inside the same /64, so IPv6 is grouped by prefix.
 */
function networkKey(ip: string): string {
  if (!ip) return "local";
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip;
  const parts = expandIpv6(ip);
  return parts ? `${parts.slice(0, 4).join(":")}::/64` : ip;
}

/** Returns an opaque lobby id shared by devices on the same network. The raw IP is never stored. */
export function GET(req: NextRequest) {
  const salt = process.env.LOBBY_SALT;
  if (!salt && process.env.NODE_ENV === "production") {
    console.warn("LOBBY_SALT is not set; using the development salt.");
  }

  const lobby = createHash("sha256")
    .update(`${salt || DEV_SALT}:${networkKey(clientIp(req))}`)
    .digest("hex")
    .slice(0, 16);

  return NextResponse.json({ lobby }, { headers: { "Cache-Control": "no-store" } });
}
