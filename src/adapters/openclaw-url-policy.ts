import { isIP } from "node:net";

const defaultOpenClawWeixinBaseUrl = "https://ilinkai.weixin.qq.com";
const allowedExactHosts = new Set(["weixin.qq.com", "openclaw.ai"]);
const allowedHostSuffixes = [".weixin.qq.com", ".openclaw.ai"];

export function normalizeOpenClawProviderBaseUrl(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const candidate = hasScheme(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("openclaw_provider_host_not_allowed");
  }

  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("openclaw_provider_host_not_allowed");
  }

  const hostname = normalizeHostname(url.hostname);
  if (!isAllowedOpenClawHostname(hostname)) {
    throw new Error("openclaw_provider_host_not_allowed");
  }

  return url.origin;
}

export function openClawProviderBaseUrlOrDefault(value: string | null | undefined): string {
  return normalizeOpenClawProviderBaseUrl(value) ?? defaultOpenClawWeixinBaseUrl;
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z\d+\-.]*:\/\//i.test(value);
}

function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  return lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
}

function isAllowedOpenClawHostname(hostname: string): boolean {
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || isIP(hostname)) {
    return false;
  }
  return allowedExactHosts.has(hostname) || allowedHostSuffixes.some((suffix) => hostname.endsWith(suffix));
}
