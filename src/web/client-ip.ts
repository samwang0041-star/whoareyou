import { isIP } from "net";

/**
 * Extract the client IP from a Request.
 *
 * Production nginx overwrites `x-real-ip` with `$remote_addr`, while
 * `x-forwarded-for` may include client-supplied values. Prefer the overwritten
 * header and only use XFF as a fallback for local/test environments.
 */
export function getClientIp(request: Request): string {
  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    const candidate = realIp.trim();
    if (isValidIp(candidate)) return candidate;
  }

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const last = forwardedFor.split(",").at(-1)?.trim();
    if (last && isValidIp(last)) return last;
  }

  return "";
}

function isValidIp(value: string): boolean {
  return isIP(value) !== 0;
}
