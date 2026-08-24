import { NextRequest, NextResponse } from "next/server";
import {
  SPOOFED_HEADERS,
  isSafeProxyTarget,
  sanitizeFilename,
  asciiFallback,
} from "@/lib/shared";

/**
 * GET /api/proxy?url=<encoded-direct-url>[&dl=1][&filename=…]
 *
 * Streams the upstream media through the serverless function so the browser
 * can preview/download it even when the origin enforces hotlink/CORS rules.
 * The upstream body is piped untouched via the standard Web ReadableStream,
 * which Vercel streams chunk-by-chunk — no buffering, no external binaries.
 *
 * Range requests are forwarded, so <video> seeking works end-to-end.
 */
export const runtime = "nodejs"; // flip to "edge" for CDN-edge streaming — code is runtime-agnostic
export const dynamic = "force-dynamic";
export const maxDuration = 60; // keep within your Vercel plan's function limit

const PASS_THROUGH_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
] as const;

function jsonError(status: number, error: string) {
  return NextResponse.json({ success: false, error }, { status });
}

function filenameFromUrl(url: URL): string {
  try {
    const seg = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
    if (/\.[a-z0-9]{1,6}$/i.test(seg)) return sanitizeFilename(seg);
  } catch {
    /* ignore */
  }
  return "ucshare-media";
}

export async function GET(request: NextRequest) {
  // ---- Parse & validate target ------------------------------------
  const params = request.nextUrl.searchParams;
  const target = params.get("url");
  if (!target) return jsonError(400, "Missing required query parameter: url.");

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return jsonError(400, "Invalid url parameter.");
  }
  if (!isSafeProxyTarget(targetUrl)) {
    return jsonError(
      403,
      "Blocked: the proxy only forwards to public http(s) endpoints on standard ports.",
    );
  }

  // ---- Upstream request with spoofed headers -----------------------
  const upstreamHeaders: Record<string, string> = {
    "User-Agent": SPOOFED_HEADERS["User-Agent"],
    Referer: "https://uc-share.com/",
    Accept: "*/*",
    "Accept-Language": SPOOFED_HEADERS["Accept-Language"],
  };
  const range = request.headers.get("range");
  if (range) upstreamHeaders.Range = range;

  let upstream: Response;
  const controller = new AbortController();
  // Abort only while waiting for response headers; the streamed body is
  // bounded by the platform function timeout instead.
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    upstream = await fetch(targetUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
      signal: controller.signal,
    });
  } catch {
    return jsonError(
      502,
      "Upstream fetch failed — the media host may be unreachable or blocking requests.",
    );
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok && upstream.status !== 206) {
    // Drain & discard body to free the connection
  try { await upstream.body?.cancel(); } catch { /* noop */ }
    return jsonError(
      502,
      `Upstream media host responded with HTTP ${upstream.status}.`,
    );
  }

  // ---- Build the streamed response ---------------------------------
  const headers = new Headers();
  for (const h of PASS_THROUGH_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/octet-stream");
  }
  headers.set("cache-control", "public, max-age=1800");
  headers.set("access-control-allow-origin", "*");

  if (params.get("dl") === "1") {
    const name = sanitizeFilename(params.get("filename") || filenameFromUrl(targetUrl));
    headers.set(
      "content-disposition",
      `attachment; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
  }

  return new Response(upstream.body, {
    status: upstream.status, // 200 or 206 (Range) pass through
    headers,
  });
}

/** Permissive CORS preflight so the API is usable from other origins. */
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "range, content-type",
      "access-control-expose-headers":
        "content-length, content-range, content-disposition, accept-ranges",
    },
  });
}
