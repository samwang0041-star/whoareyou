/**
 * Extract the client IP from a Request.
 *
 * Trusts only the leftmost entry of `x-forwarded-for` plus `x-real-ip`. When
 * deployed behind a reverse proxy, that proxy must overwrite these headers so a
 * remote client cannot spoof them. Deeper XFF hops are ignored on purpose.
 */
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  return "";
}
