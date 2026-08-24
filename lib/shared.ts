/**
 * Shared, dependency-free helpers used by both serverless route handlers.
 * Kept free of Node-only / cheerio imports so the proxy route stays lightweight
 * (it could be flipped to the Edge runtime by changing one line — see route file).
 */

/** Exact header set required by uc-share.com's bot/hotlink filters. */
export const SPOOFED_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Linux; U; Android 10; id-id; Redmi Note 8 Build/QKQ1.200114.002) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/88.0.4324.181 Mobile Safari/537.36 UCBrowser/13.4.0.1306",
  Referer: "https://uc-share.com/",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
};

/** Headers for UC Drive international API (m-intldrive.ucweb.com / uc-share.com). */
export const UC_INTL_API_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  Origin: "https://drive.ucweb.com",
  Referer: "https://drive.ucweb.com/",
  "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
};

/** Headers for UC Drive China API (pc-api.uc.cn / drive.uc.cn). */
export const UC_CN_API_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json;charset=UTF-8",
  Origin: "https://drive.uc.cn",
  Referer: "https://drive.uc.cn/",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

/** @deprecated use UC_INTL_API_HEADERS or UC_CN_API_HEADERS */
export const UC_API_HEADERS = UC_INTL_API_HEADERS;

/** Comma-separated allowlist of page hosts the extractor may fetch (env-overridable). */
export const DEFAULT_ALLOWED_PAGE_HOSTS =
  "uc-share.com,drive.ucweb.com,drive.uc.cn,fast.uc.cn,pan.uc.cn";

export function allowedPageHosts(): string[] {
  const raw =
    process.env.UCSHARE_ALLOWED_HOSTS?.trim() || DEFAULT_ALLOWED_PAGE_HOSTS;
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);
}

/**
 * Validate that `raw` is a well-formed http(s) URL on an allowlisted
 * uc-share style origin. Returns the parsed URL or null.
 */
export function parsePageUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (url.username || url.password) return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const ok = allowedPageHosts().some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
  return ok ? url : null;
}

/** True when the share page is on the international UC Drive stack. */
export function isIntlShareHost(pageUrl: URL): boolean {
  const host = pageUrl.hostname.toLowerCase().replace(/^www\./, "");
  return (
    host === "uc-share.com" ||
    host.endsWith(".uc-share.com") ||
    host === "drive.ucweb.com" ||
    host.endsWith(".ucweb.com")
  );
}

/**
 * Extract share pwd_id from common UC share URL shapes:
 *   https://uc-share.com/s/xxxxx
 *   https://drive.ucweb.com/s/xxxxx
 *   https://drive.uc.cn/s/xxxxx
 */
export function extractShareId(pageUrl: URL): string | null {
  const path = pageUrl.pathname.replace(/\/+$/, "");
  const m = path.match(/\/s\/([A-Za-z0-9_-]+)/i);
  if (m) return m[1];
  const seg = path.split("/").filter(Boolean).pop() || "";
  if (/^[A-Za-z0-9_-]{6,}$/.test(seg)) return seg;
  return null;
}

/** Passcode from ?passcode= / ?pwd= / ?code= query, or empty string. */
export function extractPasscode(pageUrl: URL, override?: string): string {
  if (typeof override === "string") return override.trim();
  const q =
    pageUrl.searchParams.get("passcode") ||
    pageUrl.searchParams.get("pwd") ||
    pageUrl.searchParams.get("code") ||
    "";
  return q.trim();
}

/* ------------------------------------------------------------------ */
/* SSRF guards for the proxy route (best-effort, no DNS resolution)    */
/* ------------------------------------------------------------------ */

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^255\.255\.255\.255$/,
];

function isPrivateV4(host: string): boolean {
  return PRIVATE_V4.some((re) => re.test(host));
}

export function isSafeProxyTarget(url: URL): boolean {
  if (!/^https?:$/.test(url.protocol)) return false;
  if (url.username || url.password) return false;

  const port = url.port === ""
    ? url.protocol === "https:"
      ? 443
      : 80
    : Number(url.port);
  if (port !== 80 && port !== 443) return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal"))
    return false;

  if (
    host === "metadata.google.internal" ||
    host === "169.254.169.254" ||
    host === "100.100.100.200"
  )
    return false;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return !isPrivateV4(host);

  if (host.includes(":")) {
    if (host === "::1" || host === "::") return false;
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return !isPrivateV4(mapped[1]);
    if (/^f[cd][0-9a-f]{0,2}(:|$)/.test(host)) return false;
    if (/^fe[89ab][0-9a-f]{0,2}(:|$)/.test(host)) return false;
  }
  return true;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "");
  return (cleaned || "ucshare-media").slice(0, 120);
}

export function asciiFallback(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
}
