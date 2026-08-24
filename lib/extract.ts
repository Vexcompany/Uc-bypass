import * as cheerio from "cheerio";
import {
  SPOOFED_HEADERS,
  UC_INTL_API_HEADERS,
  UC_CN_API_HEADERS,
  extractPasscode,
  extractShareId,
  formatBytes,
  isIntlShareHost,
} from "@/lib/shared";

export type MediaType = "video" | "file";

export interface FileEntry {
  name: string;
  directUrl: string;
  mediaType: MediaType;
  size?: string;
  sizeBytes?: number;
  isFolder?: boolean;
}

export interface ExtractedMedia {
  directUrl: string;
  mediaType: MediaType;
  title?: string;
  size?: string;
  resolution?: string;
  method: string;
  files?: FileEntry[];
  isFolder?: boolean;
}

export class ExtractionError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "ExtractionError";
    this.status = status;
  }
}

interface UcListItem {
  fid: string;
  file_name: string;
  size?: number;
  dir?: boolean;
  file?: boolean;
  file_type?: number;
  format_type?: string;
  share_fid_token?: string;
  include_items?: number;
}

const VIDEO_EXT_LIST = ["mp4", "m3u8", "webm", "mkv", "mov", "m4v", "avi", "ts", "3gp", "ogv", "flv"];
const FILE_EXT_LIST = ["zip", "rar", "7z", "tar", "gz", "mp3", "m4a", "aac", "flac", "wav", "ogg", "pdf", "apk", "exe", "iso", "epub", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt"];
const VIDEO_EXTS = new Set(VIDEO_EXT_LIST);
const FILE_EXTS = new Set(FILE_EXT_LIST);
const ALL_EXTS = [...VIDEO_EXT_LIST, ...FILE_EXT_LIST];
const EXT_PRIORITY: Record<string, number> = { mp4: 60, m3u8: 55, webm: 50, m4v: 45, mov: 45, mkv: 40, mp3: 35, ts: 30, avi: 30, flv: 25, ogv: 25, "3gp": 20 };

const UC_INTL_API = "https://m-intldrive.ucweb.com/1/clouddrive";
const UC_CN_API = "https://pc-api.uc.cn/1/clouddrive";
const MAX_FOLDER_DEPTH = 3;
const MAX_TOTAL_FILES = 40;

function extFromName(name: string): string | null {
  const m = name.match(/\.([a-z0-9]{1,5})$/i);
  return m ? m[1].toLowerCase() : null;
}
function classify(ext: string): MediaType {
  return VIDEO_EXTS.has(ext) ? "video" : "file";
}
function isDirItem(item: UcListItem): boolean {
  if (item.dir === true) return true;
  if (item.file === false) return true;
  if (item.file_type === 0) return true;
  if (item.include_items != null && item.include_items > 0 && !extFromName(item.file_name || "")) return true;
  return false;
}

async function ucFetchJson(
  url: string,
  init: RequestInit | undefined,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18_000);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new ExtractionError(`UC API HTTP ${res.status}`, res.status === 404 ? 404 : 502);
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("json")) {
      throw new ExtractionError("UC API non-JSON response", 502);
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ExtractionError) throw err;
    if (controller.signal.aborted) throw new ExtractionError("UC API timeout", 504);
    throw new ExtractionError("Could not reach UC Drive API", 502);
  } finally {
    clearTimeout(timer);
  }
}

async function extractViaIntlApi(pwdId: string, passcode: string): Promise<ExtractedMedia> {
  const rootJson = await ucFetchJson(
    `${UC_INTL_API}/share/sharepage/v2/detail?pr=UCBrowser&fr=h5`,
    {
      method: "POST",
      body: JSON.stringify({
        pwd_id: pwdId,
        passcode: passcode || "",
        force: 0,
        page: 1,
        size: 50,
        fetch_banner: 1,
        fetch_share: 1,
        fetch_total: 1,
        sort: "",
        banner_platform: "others",
        fetch_error_background: 1,
        web_platform: "others",
        fetch_follow_status: 1,
        ip_limit: "",
      }),
    },
    UC_INTL_API_HEADERS,
  );

  const code = rootJson.code as number | undefined;
  if (code !== 0 && code !== undefined) {
    const msg = String((rootJson.message as string) || "error");
    if (/pass|密码|口令/i.test(msg)) {
      throw new ExtractionError("Share requires a passcode. Enter it in the Passcode field.", 403);
    }
    throw new ExtractionError(`UC share failed: ${msg}`, 422);
  }

  const data = rootJson.data as Record<string, unknown>;
  const tokenInfo = data.token_info as Record<string, unknown>;
  const detailInfo = data.detail_info as Record<string, unknown>;
  const stoken = tokenInfo.stoken as string;
  if (!stoken) throw new ExtractionError("UC API did not return a share token.", 422);

  const rootList = (detailInfo.list as UcListItem[]) || [];
  const share = detailInfo.share as Record<string, unknown> | undefined;
  let title = (tokenInfo.title as string) || (share?.title as string) || undefined;
  const shareSize = typeof share?.size === "number" ? (share.size as number) : undefined;

  async function listDir(pdirFid: string): Promise<UcListItem[]> {
    const params = new URLSearchParams({
      pr: "UCBrowser",
      fr: "h5",
      pwd_id: pwdId,
      stoken,
      pdir_fid: pdirFid,
      force: pdirFid === "0" ? "0" : "1",
      _page: "1",
      _size: "50",
      _fetch_banner: "0",
      _fetch_share: "0",
      _fetch_total: "1",
      _sort: "file_type:asc,file_name:asc",
    });
    const json = await ucFetchJson(
      `${UC_INTL_API}/share/sharepage/detail?${params.toString()}`,
      { method: "GET" },
      UC_INTL_API_HEADERS,
    );
    const d = json.data as Record<string, unknown> | undefined;
    return (d?.list as UcListItem[]) || [];
  }

  async function resolveDl(item: UcListItem): Promise<string | null> {
    try {
      const json = await ucFetchJson(
        `${UC_INTL_API}/share/sharepage/video_preview?pr=UCBrowser&fr=h5`,
        {
          method: "POST",
          body: JSON.stringify({
            pwd_id: pwdId,
            stoken,
            fid: item.fid,
            share_fid_token: item.share_fid_token || "",
            resolutions: "normal,high,super,2k,4k",
            supports: "fmp4,m3u8",
          }),
        },
        UC_INTL_API_HEADERS,
      );
      if ((json.code as number) === 0 && json.data) {
        const blob = JSON.stringify(json.data);
        const found: string[] = [];
        const re = /https?:\/\/[^"\s]+/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(blob)) !== null) {
          const u = m[0].replace(/\\\//g, "/");
          if (/^https?:\/\//.test(u)) found.push(u);
        }
        found.sort((a, b) => {
          const sa = /\.mp4/i.test(a) ? 2 : /\.m3u8/i.test(a) ? 1 : 0;
          const sb = /\.mp4/i.test(b) ? 2 : /\.m3u8/i.test(b) ? 1 : 0;
          return sb - sa;
        });
        if (found[0]) return found[0];
      }
    } catch { /* next */ }

    try {
      const json = await ucFetchJson(
        `${UC_INTL_API}/file/download?pr=UCBrowser&fr=h5`,
        {
          method: "POST",
          body: JSON.stringify({
            fids: [item.fid],
            pwd_id: pwdId,
            stoken,
            fids_token: [item.share_fid_token || ""],
          }),
        },
        UC_INTL_API_HEADERS,
      );
      const rows = json.data as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const dl = (row.download_url as string) || (row.downloadUrl as string) || (row.url as string);
          if (dl && /^https?:\/\//i.test(dl)) return dl;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  type Queued = { fid: string; depth: number; pathPrefix: string };
  const queue: Queued[] = [];
  const mediaFiles: UcListItem[] = [];
  let sawFolder = false;

  if (rootList.length === 0) {
    throw new ExtractionError("Share found but file list is empty.", 422);
  }

  if (rootList.length === 1 && isDirItem(rootList[0])) {
    sawFolder = true;
    title = rootList[0].file_name || title;
    queue.push({ fid: rootList[0].fid, depth: 1, pathPrefix: rootList[0].file_name || "" });
  } else {
    for (const item of rootList) {
      if (isDirItem(item)) {
        sawFolder = true;
        queue.push({ fid: item.fid, depth: 1, pathPrefix: item.file_name || "" });
      } else {
        mediaFiles.push(item);
      }
    }
  }

  while (queue.length > 0 && mediaFiles.length < MAX_TOTAL_FILES) {
    const cur = queue.shift()!;
    if (cur.depth > MAX_FOLDER_DEPTH) continue;
    let list: UcListItem[] = [];
    try {
      list = await listDir(cur.fid);
    } catch {
      continue;
    }
    for (const item of list) {
      if (isDirItem(item)) {
        sawFolder = true;
        if (cur.depth < MAX_FOLDER_DEPTH) {
          queue.push({
            fid: item.fid,
            depth: cur.depth + 1,
            pathPrefix: cur.pathPrefix ? `${cur.pathPrefix}/${item.file_name}` : item.file_name,
          });
        }
        continue;
      }
      const pathName = cur.pathPrefix ? `${cur.pathPrefix}/${item.file_name}` : item.file_name;
      mediaFiles.push({ ...item, file_name: pathName });
      if (mediaFiles.length >= MAX_TOTAL_FILES) break;
    }
  }

  if (mediaFiles.length === 0) {
    const sizeHint = shareSize && shareSize > 0 ? ` (~${formatBytes(shareSize)})` : "";
    throw new ExtractionError(
      `This is a folder share "${title || "unknown"}"${sizeHint}. UC blocked listing files inside (common without login for large folders). Try sharing a single file instead of the whole folder.`,
      422,
    );
  }

  mediaFiles.sort((a, b) => {
    const ea = extFromName(a.file_name || "") || "";
    const eb = extFromName(b.file_name || "") || "";
    return (EXT_PRIORITY[eb] ?? 10) - (EXT_PRIORITY[ea] ?? 10);
  });

  const resolved: FileEntry[] = [];
  for (const f of mediaFiles.slice(0, MAX_TOTAL_FILES)) {
    const dl = await resolveDl(f);
    if (!dl) continue;
    const ext = extFromName(f.file_name || "") || "bin";
    resolved.push({
      name: f.file_name || "file",
      directUrl: dl,
      mediaType: classify(ext),
      size: f.size != null && f.size > 0 ? formatBytes(f.size) : undefined,
      sizeBytes: f.size,
    });
  }

  if (resolved.length === 0) {
    throw new ExtractionError(
      `Found ${mediaFiles.length} file(s) but UC did not return download URLs (login may be required for this share).`,
      422,
    );
  }

  const best = resolved[0];
  return {
    directUrl: best.directUrl,
    mediaType: best.mediaType,
    title: title || (sawFolder ? `Folder (${resolved.length} files)` : best.name),
    size: best.size,
    method: sawFolder ? "UC Intl API (folder listing)" : "UC Intl API",
    files: resolved.length > 1 ? resolved : undefined,
    isFolder: sawFolder || resolved.length > 1,
  };
}

export async function extractFromPage(
  pageUrl: URL,
  options?: { passcode?: string },
): Promise<ExtractedMedia> {
  const pwdId = extractShareId(pageUrl);
  if (!pwdId) {
    throw new ExtractionError("Could not parse share id from URL.", 400);
  }
  const passcode = extractPasscode(pageUrl, options?.passcode);

  // Always prefer international API for uc-share.com / drive.ucweb.com
  if (isIntlShareHost(pageUrl) || true) {
    // try intl first for all share hosts (CN shares may 404, then we surface clear error)
    try {
      return await extractViaIntlApi(pwdId, passcode);
    } catch (err) {
      if (err instanceof ExtractionError) throw err;
      throw new ExtractionError("Unexpected error while contacting UC API.", 500);
    }
  }
}
