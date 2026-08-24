"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  Download,
  ExternalLink,
  File,
  Film,
  Folder,
  Globe,
  HardDrive,
  Link2,
  Loader2,
  MonitorPlay,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface FileEntry {
  name: string;
  directUrl: string;
  mediaType: "video" | "file";
  size?: string;
}

interface ExtractResponse {
  success: boolean;
  title?: string;
  directUrl?: string;
  mediaType?: "video" | "file";
  size?: string;
  resolution?: string;
  method?: string;
  sourceDomain?: string;
  isFolder?: boolean;
  files?: FileEntry[];
  error?: string;
}

interface HistoryItem {
  pageUrl: string;
  title: string;
  directUrl: string;
  mediaType: "video" | "file";
  at: number;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const HISTORY_KEY = "ucx.history.v1";
const NATIVE_VIDEO_RE = /\.(mp4|webm|mov|m4v|ogv)(?:[?#]|$)/i;

function proxyUrl(directUrl: string, opts: { download?: boolean; filename?: string } = {}): string {
  const p = new URLSearchParams({ url: directUrl });
  if (opts.download) {
    p.set("dl", "1");
    if (opts.filename) p.set("filename", opts.filename);
  }
  return `/api/proxy?${p.toString()}`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "ucshare-media";
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Small presentational components                                     */
/* ------------------------------------------------------------------ */

function Badge({ icon: Icon, label, tone = "zinc" }: { icon: LucideIcon; label: string; tone?: "zinc" | "violet" | "sky" | "emerald" }) {
  const tones: Record<string, string> = {
    zinc: "border-white/10 bg-white/5 text-zinc-300",
    violet: "border-violet-500/25 bg-violet-500/10 text-violet-300",
    sky: "border-sky-500/25 bg-sky-500/10 text-sky-300",
    emerald: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${tones[tone]}`}
      title={label}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

function StepCard({ icon: Icon, step, title, desc }: { icon: LucideIcon; step: string; title: string; desc: string }) {
  return (
    <div className="group rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition-all duration-300 hover:-translate-y-1 hover:border-violet-500/30 hover:bg-white/[0.05]">
      <div className="flex items-center justify-between">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/10 text-violet-300 transition-transform duration-300 group-hover:scale-110">
          <Icon className="h-5 w-5" />
        </div>
        <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-600">{step}</span>
      </div>
      <h3 className="mt-4 text-sm font-semibold text-zinc-100">{title}</h3>
      <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">{desc}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function HomePage() {
  const [input, setInput] = useState("");
  const [passcode, setPasscode] = useState("");
  const [status, setStatus] = useState<"idle" | "loading">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractResponse | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [liveRes, setLiveRes] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) setHistory(JSON.parse(raw));
    } catch {
      /* corrupt storage — ignore */
    }
  }, []);

  const showToast = useCallback((kind: "ok" | "err", text: string) => {
    setToast({ kind, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const activeUrl = selectedFile?.directUrl || result?.directUrl;
  const activeMediaType = selectedFile?.mediaType || result?.mediaType;
  const activeName = selectedFile?.name || result?.title;

  const extract = useCallback(
    async (rawUrl: string) => {
      const url = rawUrl.trim();
      if (!url) {
        showToast("err", "Paste a uc-share / drive.uc.cn link first.");
        inputRef.current?.focus();
        return;
      }
      setStatus("loading");
      setError(null);
      setResult(null);
      setSelectedFile(null);
      setLiveRes(null);
      setCopied(false);
      try {
        const res = await fetch("/api/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url,
            ...(passcode.trim() ? { passcode: passcode.trim() } : {}),
          }),
        });
        const data: ExtractResponse = await res.json();
        if (!res.ok || !data.success || !data.directUrl) {
          setError(data.error || `Extraction failed (HTTP ${res.status}).`);
          setStatus("idle");
          return;
        }
        setResult(data);
        if (data.files && data.files.length > 0) {
          setSelectedFile(data.files[0]);
        }
        setStatus("idle");
        showToast(
          "ok",
          data.isFolder || (data.files && data.files.length > 1)
            ? `Folder resolved — ${data.files?.length ?? 1} file(s).`
            : "Direct media link resolved.",
        );
        setHistory((prev) => {
          const next = [
            {
              pageUrl: url,
              title: data.title || url,
              directUrl: data.directUrl as string,
              mediaType: data.mediaType || "file",
              at: Date.now(),
            },
            ...prev.filter((h) => h.directUrl !== data.directUrl),
          ].slice(0, 6);
          try {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
          } catch {
            /* storage full/private — ignore */
          }
          return next;
        });
      } catch {
        setError("Could not reach the extraction API. Check your connection and try again.");
        setStatus("idle");
      }
    },
    [showToast, passcode],
  );

  const copyDirect = useCallback(async () => {
    if (!activeUrl) return;
    const ok = await copyText(activeUrl);
    if (ok) {
      setCopied(true);
      showToast("ok", "Direct URL copied to clipboard.");
      setTimeout(() => setCopied(false), 2200);
    } else {
      showToast("err", "Copy failed — your browser blocked clipboard access.");
    }
  }, [activeUrl, showToast]);

  const fileName = useMemo(() => {
    if (selectedFile?.name && /\.[a-z0-9]{1,6}$/i.test(selectedFile.name)) {
      return selectedFile.name.split("/").pop() || selectedFile.name;
    }
    if (!activeUrl) return "";
    try {
      const u = new URL(activeUrl);
      const seg = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
      if (/\.[a-z0-9]{1,6}$/i.test(seg)) return seg;
    } catch {
      /* ignore */
    }
    const m = activeUrl.match(/\.([a-z0-9]{1,6})(?:[?#]|$)/i);
    const ext = m?.[1] || (activeMediaType === "video" ? "mp4" : "bin");
    return `${slugify(activeName || "ucshare-media")}.${ext}`;
  }, [activeUrl, activeMediaType, activeName, selectedFile]);

  const clearHistory = useCallback(() => {
    setHistory([]);
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const busy = status === "loading";
  const playable = !!activeUrl && NATIVE_VIDEO_RE.test(activeUrl);
  const multiFiles = result?.files && result.files.length > 1;

  return (
    <main className="relative min-h-screen overflow-hidden">
      {/* Ambient background */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-48 left-1/2 h-[36rem] w-[36rem] -translate-x-1/2 animate-float-slow rounded-full bg-violet-600/20 blur-[130px]" />
        <div className="absolute -right-32 top-1/3 h-[26rem] w-[26rem] rounded-full bg-sky-500/10 blur-[120px]" />
        <div className="absolute -left-32 bottom-0 h-[22rem] w-[22rem] rounded-full bg-fuchsia-600/10 blur-[120px]" />
      </div>

      <div className="relative mx-auto flex min-h-screen w-full max-w-3xl flex-col px-4 pb-16 pt-16 sm:pt-24">
        {/* ---------------- Hero ---------------- */}
        <header className="animate-fade-in text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-violet-500/25 bg-violet-500/10 px-3 py-1 text-[11px] font-medium tracking-wide text-violet-300">
            <Zap className="h-3.5 w-3.5" />
            Serverless · Folder support · Zero ads
          </span>
          <h1 className="mt-6 text-4xl font-bold tracking-tight text-white sm:text-5xl">
            UC-Share{" "}
            <span className="bg-gradient-to-r from-violet-400 via-fuchsia-400 to-sky-400 bg-clip-text text-transparent">
              Media Extractor
            </span>
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-zinc-400 sm:text-base">
            Paste a uc-share.com / drive.uc.cn link — works for single files and
            folder shares. Inline preview, one-click download, no redirects.
          </p>
        </header>

        {/* ---------------- Input form ---------------- */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            extract(input);
          }}
          className="mt-10 animate-slide-up"
          aria-live="polite"
        >
          <div
            className={`flex flex-col gap-2 rounded-2xl border p-2 shadow-2xl shadow-black/50 backdrop-blur transition-colors duration-300 ${
              busy ? "border-violet-500/50 bg-white/[0.07]" : "border-white/10 bg-white/[0.04] hover:border-white/20"
            }`}
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="flex flex-1 items-center gap-3 px-3">
                <Link2 className="h-4 w-4 shrink-0 text-zinc-500" />
                <input
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  disabled={busy}
                  placeholder="https://uc-share.com/s/… or https://drive.uc.cn/s/…"
                  spellCheck={false}
                  autoComplete="off"
                  inputMode="url"
                  aria-label="UC share link"
                  className="w-full bg-transparent py-3 text-sm text-zinc-100 caret-violet-400 outline-none placeholder:text-zinc-600 disabled:opacity-50"
                />
                {input && !busy && (
                  <button
                    type="button"
                    onClick={() => {
                      setInput("");
                      inputRef.current?.focus();
                    }}
                    className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
                    aria-label="Clear input"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              <button
                type="submit"
                disabled={busy}
                className="group inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-950/40 transition-all duration-200 hover:from-violet-500 hover:to-indigo-500 hover:shadow-violet-900/40 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 sm:min-w-[168px]"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4 transition-transform duration-300 group-hover:rotate-12" />
                )}
                {busy ? "Extracting…" : "Extract Media"}
              </button>
            </div>
            <div className="flex items-center gap-3 border-t border-white/5 px-3 pt-2">
              <span className="shrink-0 text-[11px] text-zinc-500">Passcode</span>
              <input
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                disabled={busy}
                placeholder="optional — if the share is locked"
                spellCheck={false}
                autoComplete="off"
                className="w-full bg-transparent py-2 text-sm text-zinc-100 caret-violet-400 outline-none placeholder:text-zinc-600 disabled:opacity-50"
              />
            </div>
          </div>
        </form>

        {/* ---------------- Error alert ---------------- */}
        {error && (
          <div
            role="alert"
            className="mt-5 flex items-start gap-3 animate-slide-up rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="flex-1 leading-relaxed">{error}</p>
            <button
              onClick={() => setError(null)}
              className="rounded-md p-0.5 text-red-400/70 transition-colors hover:text-red-200"
              aria-label="Dismiss error"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* ---------------- Loading skeleton ---------------- */}
        {busy && (
          <div className="mt-8 animate-slide-up rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <div className="flex items-center gap-3 text-sm text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
              Resolving share via UC API (folders + files), then HTML fallback…
            </div>
            <div className="mt-5 space-y-3">
              <div className="aspect-video w-full animate-pulse rounded-xl bg-white/[0.05]" />
              <div className="h-4 w-2/3 animate-pulse rounded-md bg-white/[0.05]" />
              <div className="h-4 w-1/3 animate-pulse rounded-md bg-white/[0.05]" />
            </div>
          </div>
        )}

        {/* ---------------- Success result ---------------- */}
        {result && !busy && (
          <section className="mt-8 animate-slide-up rounded-2xl border border-white/10 bg-white/[0.03] p-5 shadow-2xl shadow-black/40">
            {/* header */}
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                    <Check className="h-3 w-3" /> Resolved
                  </span>
                  {result.isFolder && (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-amber-300">
                      <Folder className="h-3 w-3" /> Folder
                    </span>
                  )}
                  <span className="text-[11px] text-zinc-600">via {result.method}</span>
                </div>
                <h2 className="mt-2 truncate text-base font-semibold text-zinc-100" title={result.title}>
                  {result.title || "Untitled media"}
                </h2>
              </div>
            </div>

            {/* folder file list */}
            {multiFiles && (
              <div className="mt-4 max-h-48 space-y-1 overflow-y-auto rounded-xl border border-white/10 bg-black/30 p-2">
                {result.files!.map((f) => {
                  const active = selectedFile?.directUrl === f.directUrl;
                  return (
                    <button
                      key={f.directUrl + f.name}
                      type="button"
                      onClick={() => {
                        setSelectedFile(f);
                        setLiveRes(null);
                        setCopied(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                        active
                          ? "bg-violet-500/20 text-violet-100"
                          : "text-zinc-300 hover:bg-white/5"
                      }`}
                    >
                      {f.mediaType === "video" ? (
                        <Film className="h-3.5 w-3.5 shrink-0 text-violet-400" />
                      ) : (
                        <File className="h-3.5 w-3.5 shrink-0 text-sky-400" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      {f.size && (
                        <span className="shrink-0 font-mono text-[10px] text-zinc-500">{f.size}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* player / stream notice */}
            <div className="mt-4">
              {playable ? (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video
                  key={activeUrl}
                  controls
                  playsInline
                  preload="metadata"
                  src={proxyUrl(activeUrl as string)}
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    if (v.videoWidth) setLiveRes(`${v.videoWidth}×${v.videoHeight}`);
                  }}
                  className="aspect-video w-full rounded-xl border border-white/10 bg-black shadow-lg shadow-black/50"
                />
              ) : (
                <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/15 bg-black/40 px-6 text-center">
                  {activeMediaType === "video" ? (
                    <Film className="h-10 w-10 text-violet-400" />
                  ) : (
                    <File className="h-10 w-10 text-sky-400" />
                  )}
                  <p className="text-sm font-medium text-zinc-200">
                    {activeMediaType === "video"
                      ? "Stream link resolved (e.g. HLS / .m3u8)"
                      : "File link resolved"}
                  </p>
                  <p className="max-w-sm text-xs leading-relaxed text-zinc-500">
                    {activeMediaType === "video"
                      ? "This format can't preview natively in the browser — copy the URL into VLC or mpv, or use download below."
                      : "This file type has no inline preview — use the download or copy actions below."}
                  </p>
                </div>
              )}
            </div>

            {/* metadata badges */}
            <div className="mt-4 flex flex-wrap gap-2">
              <Badge
                icon={activeMediaType === "video" ? Film : File}
                label={activeMediaType === "video" ? "Video" : "File"}
                tone={activeMediaType === "video" ? "violet" : "sky"}
              />
              {(liveRes || result.resolution) && (
                <Badge icon={MonitorPlay} label={liveRes || (result.resolution as string)} />
              )}
              {(selectedFile?.size || result.size) && (
                <Badge icon={HardDrive} label={(selectedFile?.size || result.size) as string} />
              )}
              {result.sourceDomain && <Badge icon={Globe} label={result.sourceDomain} />}
            </div>

            {/* direct url line */}
            <div className="mt-4 rounded-xl border border-white/10 bg-black/40 p-3">
              <p className="break-all font-mono text-[11px] leading-relaxed text-zinc-400" style={{ wordBreak: "break-all" }}>
                {activeUrl}
              </p>
            </div>

            {/* actions */}
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <a
                href={proxyUrl(activeUrl as string, { download: true, filename: fileName })}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-950/40 transition-all duration-200 hover:from-emerald-500 hover:to-teal-500 active:scale-[0.98]"
              >
                <Download className="h-4 w-4" />
                Download File
              </a>
              <button
                onClick={copyDirect}
                className={`inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition-all duration-200 active:scale-[0.98] ${
                  copied
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    : "border-white/15 bg-white/5 text-zinc-200 hover:border-white/30 hover:bg-white/10"
                }`}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copied!" : "Copy Direct URL"}
              </button>
              <a
                href={activeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-zinc-200 transition-all duration-200 hover:border-white/30 hover:bg-white/10 active:scale-[0.98]"
              >
                <ExternalLink className="h-4 w-4" />
                Open Raw
              </a>
            </div>
          </section>
        )}

        {/* ---------------- Empty state ---------------- */}
        {!result && !busy && !error && (
          <div className="mt-12 animate-slide-up">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StepCard
                icon={Link2}
                step="Step 1"
                title="Paste the link"
                desc="uc-share.com or drive.uc.cn — single file or whole folder. Add passcode if the share is locked."
              />
              <StepCard
                icon={Folder}
                step="Step 2"
                title="API + HTML resolve"
                desc="We call UC Drive share API to list folders, then fall back to DOM/script scraping if needed."
              />
              <StepCard
                icon={Download}
                step="Step 3"
                title="Preview & download"
                desc="Pick a file from the folder list, play inline, copy the direct URL, or download via proxy."
              />
            </div>
            <p className="mt-6 flex items-center justify-center gap-2 text-center text-xs text-zinc-600">
              <ShieldCheck className="h-3.5 w-3.5" />
              Only extracts links from pages you already have access to. Nothing is stored on the server.
            </p>
          </div>
        )}

        {/* ---------------- History ---------------- */}
        {history.length > 0 && !busy && (
          <section className="mt-10">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">
                <Clock className="h-3.5 w-3.5" /> Recent extractions
              </h3>
              <button
                onClick={clearHistory}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-600 transition-colors hover:bg-white/5 hover:text-red-400"
              >
                <Trash2 className="h-3.5 w-3.5" /> Clear
              </button>
            </div>
            <div className="space-y-2">
              {history.map((h) => (
                <button
                  key={h.directUrl + h.at}
                  onClick={() => {
                    setInput(h.pageUrl);
                    extract(h.pageUrl);
                  }}
                  className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5 text-left transition-all duration-200 hover:border-violet-500/30 hover:bg-white/[0.05]"
                >
                  {h.mediaType === "video" ? (
                    <Film className="h-4 w-4 shrink-0 text-violet-400" />
                  ) : (
                    <File className="h-4 w-4 shrink-0 text-sky-400" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm text-zinc-300">{h.title}</span>
                  <span className="hidden shrink-0 font-mono text-[10px] text-zinc-600 sm:inline">
                    {new URL(h.directUrl).hostname}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* ---------------- Footer ---------------- */}
        <footer className="mt-auto pt-16 text-center text-xs leading-relaxed text-zinc-600">
          <p>
            Built with Next.js App Router · Tailwind CSS · Lucide — runs fully on
            Vercel serverless functions.
          </p>
          <p className="mt-1">Use only for content you have the right to access.</p>
        </footer>
      </div>

      {/* ---------------- Toast ---------------- */}
      {toast && (
        <div
          role="status"
          className={`fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 animate-toast-in items-center gap-2.5 rounded-xl border px-4 py-3 text-sm font-medium shadow-2xl shadow-black/60 backdrop-blur ${
            toast.kind === "ok"
              ? "border-emerald-500/30 bg-emerald-950/90 text-emerald-300"
              : "border-red-500/30 bg-red-950/90 text-red-300"
          }`}
        >
          {toast.kind === "ok" ? (
            <Check className="h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="h-4 w-4 shrink-0" />
          )}
          {toast.text}
        </div>
      )}
    </main>
  );
}
