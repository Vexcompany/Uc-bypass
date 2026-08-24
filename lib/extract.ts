import * as cheerio from "cheerio";
import { SPOOFED_HEADERS, formatBytes } from "@/lib/shared";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type MediaType = "video" | "file";

export interface ExtractedMedia {
  directUrl: string;
  mediaType: MediaType;
  title?: string;
  size?: string;
  resolution?: string;
  /** Human-readable description of which extraction tier produced the hit. */
  method: string;
}

export class ExtractionError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "ExtractionError";
    this.status = status;
  }
}

interface Candidate {
  url: URL;
  ext: string;
  tier: Tier;
  label: string;
}

type Tier = "tag" | "meta" | "script" | "anchor" | "regex";

/* ------------------------------------------------------------------ */
/* Extension knowledge                                                 */
/* ------------------------------------------------------------------ */

const VIDEO_EXT_LIST = [
  "mp4", "m3u8", "webm", "mkv", "mov", "m4v", "avi", "ts", "3gp", "ogv", "flv",
];
const FILE_EXT_LIST = [
  "zip", "rar", "7z", "tar", "gz", "mp3", "m4a", "aac", "flac", "wav", "ogg",
  "pdf", "apk", "exe", "iso", "epub", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt",
];
const VIDEO_EXTS = new Set<string>(VIDEO_EXT_LIST);
const FILE_EXTS = new Set<string>(FILE_EXT_LIST);
const ALL_EXTS = [...VIDEO_EXT_LIST, ...FILE_EXT_LIST];

/** Higher = preferred when several links are found (mp4 plays natively everywhere). */
const EXT_PRIORITY: Record<string, number> = {
  mp4: 60, m3u8: 55, webm: 50, m4v: 45, mov: 45, mkv: 40, mp3: 35,
  ts: 30, avi: 30, flv: 25, ogv: 25, "3gp": 20,
};
const TIER_PRIORITY: Record<Tier, number> = {
  tag: 40, meta: 35, script: 30, anchor: 25, regex: 20,
};

/* ------------------------------------------------------------------ */
/* URL helpers                                                         */
/* ------------------------------------------------------------------ */

/** Undo common JS/HTML escaping so embedded URLs become parseable. */
function decodeLight(s: string): string {
  return s
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x3A;/gi, ":")
    .replace(/&#58;/g, ":")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/");
}

function extOf(url: URL): string | null {
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep raw */
  }
  const m = path.match(/\.([a-z0-9]{1,5})$/i);
  return m ? m[1].toLowerCase() : null;
}

function isMediaExt(ext: string): boolean {
  return VIDEO_EXTS.has(ext) || FILE_EXTS.has(ext);
}

function classify(ext: string): MediaType {
  return VIDEO_EXTS.has(ext) ? "video" : "file";
}

/** Resolve `raw` against `base`, accept only absolute http(s) media URLs. */
function toMediaUrl(raw: string, base: URL): URL | null {
  if (!raw) return null;
  let s = raw.trim();
  if (/^(javascript:|mailto:|tel:|data:|blob:)/i.test(s)) return null;
  s = decodeLight(s);
  let u: URL;
  try {
    u = new URL(s, base);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const ext = extOf(u);
  if (!ext || !isMediaExt(ext)) return null;
  return u;
}

function pushCandidate(
  out: Candidate[],
  raw: string,
  base: URL,
  tier: Tier,
  label: string,
): void {
  const u = toMediaUrl(raw, base);
  if (u) out.push({ url: u, ext: extOf(u) as string, tier, label });
}

/* ------------------------------------------------------------------ */
/* Tier 1 — HTML DOM parsing (cheerio)                                 */
/* ------------------------------------------------------------------ */

const SRC_ATTRS = [
  "src", "data-src", "data-video-src", "data-video", "data-url", "data-file",
];

export function fromDom(html: string, base: URL): Candidate[] {
  const $ = cheerio.load(html);
  const out: Candidate[] = [];

  $("video, audio, source").each((_, el) => {
    const $el = $(el);
    for (const attr of SRC_ATTRS) {
      const v = $el.attr(attr);
      if (v) {
        pushCandidate(out, v, base, "tag", "HTML <video>/<source> tag");
      }
    }
  });

  $("a[href], a[data-href]").each((_, el) => {
    const $el = $(el);
    const v = $el.attr("href") || $el.attr("data-href") || "";
    if (!v || v.startsWith("#")) return;
    pushCandidate(out, v, base, "anchor", "Download anchor (<a href>)");
  });

  return out;
}

/** Open Graph / Twitter player metas are the most reliable hints on share pages. */
export function fromMeta(html: string, base: URL): Candidate[] {
  const $ = cheerio.load(html);
  const out: Candidate[] = [];
  const selectors = [
    'meta[property="og:video:secure_url"]',
    'meta[property="og:video:url"]',
    'meta[property="og:video"]',
    'meta[property="og:audio:secure_url"]',
    'meta[property="og:audio:url"]',
    'meta[property="og:audio"]',
    'meta[name="twitter:player:stream"]',
    'link[rel="video_src"]',
  ];
  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const $el = $(el);
      pushCandidate(
        out,
        $el.attr("content") || $el.attr("href") || "",
        base,
        "meta",
        "Open Graph / player meta tag",
      );
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Tier 2 — inline <script> JSON configs + quoted media URLs           */
/* ------------------------------------------------------------------ */

/** Yield balanced `{...}` substrings (string/escape aware) for JSON.parse attempts. */
function* jsonBlobs(code: string): Generator<string> {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
    } else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        yield code.slice(start, i + 1);
        start = -1;
      }
    }
  }
}

/** Walk a parsed JSON value collecting every string value (bounded depth). */
function collectStrings(node: unknown, out: string[], depth = 0): void {
  if (depth > 8 || out.length > 500) return;
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const n of node) collectStrings(n, out, depth + 1);
  else if (node && typeof node === "object")
    for (const v of Object.values(node as Record<string, unknown>))
      collectStrings(v, out, depth + 1);
}

export function fromScripts(html: string, base: URL): Candidate[] {
  const $ = cheerio.load(html);
  const out: Candidate[] = [];
  const label = "Inline script / player config";

  // Covers JWplayer `.setup({file:"…"})`, `sources:[{src:"…"}]`, window.__DATA__…
  const quotedMedia = new RegExp(
    `["']([^'"\\\\ ]{8,}\\.(?:${ALL_EXTS.join("|")})(?:[?][^'" ]*)?)["']`,
    "gi",
  );

  $("script").each((_, el) => {
    const code = $(el).text() ?? "";
    if (!code) return;

    // (a) any quoted media URL inside JS, JSON.parse-able or not
    quotedMedia.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = quotedMedia.exec(code)) !== null) {
      pushCandidate(out, m[1], base, "script", label);
    }

    // (b) balanced JSON blobs → parse → walk every string value
    let blobs = 0;
    for (const blob of jsonBlobs(code)) {
      if (++blobs > 64 || blob.length > 300_000) continue;
      try {
        const parsed: unknown = JSON.parse(blob);
        const strings: string[] = [];
        collectStrings(parsed, strings);
        for (const s of strings) pushCandidate(out, s, base, "script", label);
      } catch {
        /* not strict JSON — tier (a) already scanned it */
      }
    }
  });

  return out;
}

/* ------------------------------------------------------------------ */
/* Tier 3 — raw regex sweep of the whole (unescaped) document          */
/* ------------------------------------------------------------------ */

export function fromRawScan(html: string, base: URL): Candidate[] {
  const out: Candidate[] = [];
  const norm = decodeLight(html);
  const urlLike = /https?:\/\/[^\s"'<>\\`)\]]+/gi;
  let m: RegExpExecArray | null;
  while ((m = urlLike.exec(norm)) !== null) {
    pushCandidate(out, m[0].replace(/[.,;:!]+$/, ""), base, "regex", "Raw page scan");
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

function pickBest(candidates: Candidate[]): Candidate | null {
  const seen = new Map<string, Candidate>();
  for (const c of candidates) {
    const key = c.url.toString().replace(/#.*$/, "");
    if (!seen.has(key)) seen.set(key, c);
  }
  const list = [...seen.values()];
  if (list.length === 0) return null;
  const score = (c: Candidate) =>
    (EXT_PRIORITY[c.ext] ?? 12) * 10 + TIER_PRIORITY[c.tier];
  list.sort((a, b) => score(b) - score(a));
  return list[0];
}

/* ------------------------------------------------------------------ */
/* Page-level metadata                                                 */
/* ------------------------------------------------------------------ */

function extractTitle(html: string): string | undefined {
  const $ = cheerio.load(html);
  const t =
    $('meta[property="og:title"]').attr("content") ||
    $('meta[name="twitter:title"]').attr("content") ||
    $("title").first().text() ||
    "";
  const clean = t.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 180) : undefined;
}

function extractResolution(html: string): string | undefined {
  const $ = cheerio.load(html);
  const w =
    $('meta[property="og:video:width"]').attr("content") ||
    $('meta[name="twitter:player:width"]').attr("content");
  const h =
    $('meta[property="og:video:height"]').attr("content") ||
    $('meta[name="twitter:player:height"]').attr("content");
  if (w && h && /^\d+$/.test(w) && /^\d+$/.test(h)) return `${w}×${h}`;
  const m = html.match(
    /\b(3840x2160|2560x1440|1920x1080|1280x720|854x480|640x360|426x240|2160p|1080p|720p|480p|360p|240p)\b/i,
  );
  return m ? m[1].toLowerCase() : undefined;
}

function sizeHint(html: string): string | undefined {
  const m = html.match(
    /\bsize\b[^0-9\n]{0,24}(\d+(?:[.,]\d+)?\s*(?:KB|MB|GB|TB))/i,
  );
  return m ? m[1].replace(/\s+/, " ") : undefined;
}

/* ------------------------------------------------------------------ */
/* HEAD probe (size confirmation, best-effort)                         */
/* ------------------------------------------------------------------ */

async function probeMedia(url: URL): Promise<{ size?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7_000);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: { ...SPOOFED_HEADERS, Accept: "*/*" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (res.ok) {
      const len = Number(res.headers.get("content-length"));
      if (Number.isFinite(len) && len > 0) return { size: formatBytes(len) };
    }
    return {};
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

export async function extractFromPage(pageUrl: URL): Promise<ExtractedMedia> {
  let res: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    res = await fetch(pageUrl.toString(), {
      headers: SPOOFED_HEADERS,
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ExtractionError(
        "The source page took too long to respond. Try again.",
        504,
      );
    }
    throw new ExtractionError(
      "Could not reach the source page. It may be offline, region-blocked, or the link is invalid.",
      502,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new ExtractionError(
      `The source page refused access (HTTP ${res.status}). The file may be private or expired.`,
      res.status,
    );
  }
  if (res.status === 404) {
    throw new ExtractionError(
      "Page not found (HTTP 404) — double-check the link.",
      404,
    );
  }
  if (!res.ok) {
    throw new ExtractionError(
      `The source page responded with HTTP ${res.status}.`,
      502,
    );
  }

  const html = (await res.text()).slice(0, 3_000_000);

  const candidates = [
    ...fromDom(html, pageUrl),
    ...fromMeta(html, pageUrl),
    ...fromScripts(html, pageUrl),
    ...fromRawScan(html, pageUrl),
  ];
  const best = pickBest(candidates);
  if (!best) {
    throw new ExtractionError(
      "No direct media link was found on this page. The content may require JavaScript rendering, or the share has expired.",
      422,
    );
  }

  const probe = await probeMedia(best.url);

  return {
    directUrl: best.url.toString(),
    mediaType: classify(best.ext),
    title: extractTitle(html),
    size: probe.size ?? sizeHint(html),
    resolution: extractResolution(html),
    method: best.label,
  };
}
