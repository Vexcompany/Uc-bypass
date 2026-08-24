# UC-Share Media Extractor

Resolve and extract **direct media links** from `uc-share.com` URLs — inline video preview, one-click download, copy-direct-URL. Built with **Next.js 14 (App Router) + TypeScript + Tailwind CSS + Lucide**, designed for **one-click deployment on Vercel** with zero external binaries (no Puppeteer — just `fetch` + cheerio/regex parsing).

## File tree

```
ucshare-extractor/
├── package.json                  # deps: next 14, react 18, cheerio, lucide-react, tailwind
├── next.config.mjs
├── tsconfig.json
├── tailwind.config.ts            # custom animations (fade-in, slide-up, toast-in, float)
├── postcss.config.mjs
├── .gitignore
├── README.md
├── app/
│   ├── layout.tsx                # root layout, Inter font, metadata
│   ├── globals.css               # dark-mode base + custom scrollbars
│   ├── icon.svg                  # favicon
│   ├── page.tsx                  # ⭐ frontend: hero, input, 4 states, player, badges, history
│   └── api/
│       ├── extract/
│       │   └── route.ts          # ⭐ POST — validates URL, spoofed fetch, multi-tier extraction
│       └── proxy/
│           └── route.ts          # ⭐ GET — streaming CORS/hotlink proxy with Range support
├── lib/
│   ├── shared.ts                 # spoofed headers, URL allowlist, SSRF guards, formatting
│   └── extract.ts                # multi-tier extraction engine (cheerio + script JSON + regex)
└── scripts/
    └── mock-ucshare.mjs          # local fixture page to test every extraction tier end-to-end
```

## How it works

### `POST /api/extract` — resolve a share page

```jsonc
// request
{ "url": "https://uc-share.com/s/abc123" }

// response
{
  "success": true,
  "title": "Some shared video",
  "directUrl": "https://cdn.example.com/file.mp4",
  "mediaType": "video",          // 'video' | 'file'
  "size": "968 KB",              // via HEAD probe (best-effort)
  "resolution": "640×360",       // og:video:width/height or page text
  "method": "HTML <video>/<source> tag",
  "sourceDomain": "cdn.example.com"
}
```

The page is fetched **server-side** with the exact spoofed headers required by uc-share.com's bot filters (Android/UCBrowser User-Agent, `Referer: https://uc-share.com/`, mobile Accept). Extraction then runs in four tiers, ranked by reliability + format priority (`.mp4` > `.m3u8` > others):

| Tier | Strategy |
|---|---|
| 1. DOM | cheerio scan of `<video src>`, `<source src>` (+`data-*` variants), `<a href>` media links, `og:video` / `twitter:player` metas |
| 2. Scripts | inline `<script>` parsing — quoted media URLs (JWplayer `.setup({file})`) **and** balanced-JSON blob walker for embedded config (`sources:[{src}]`) |
| 3. Raw scan | regex sweep of the whole document after unescaping `\/`, `\u002F`, `&amp;`, HTML entities |
| 4. Probe | `HEAD` the winning URL for real Content-Length/Content-Type |

### `GET /api/proxy?url=<direct-url>` — stream past hotlink/CORS blocks

- Pipes upstream chunks untouched via standard Web `ReadableStream` (Vercel streaming-compatible).
- Forwards **`Range`** headers and passes through `206 Partial Content` → `<video>` seeking works.
- `&dl=1&filename=…` → `Content-Disposition: attachment` with RFC 5987 UTF-8 filename.
- Sends the spoofed UA + `Referer: https://uc-share.com/` upstream to defeat hotlink protection.
- **SSRF-hardened**: public http(s) targets on ports 80/443 only; blocks loopback/private/link-local ranges, cloud metadata endpoints, and credential URLs.

## Run locally

```bash
npm install
npm run dev            # http://localhost:3000

# optional: end-to-end test against the fixture page (no real share link needed)
node scripts/mock-ucshare.mjs          # serves http://127.0.0.1:8080/v/abc123
UCSHARE_ALLOWED_HOSTS="uc-share.com,127.0.0.1" npm run dev
curl -X POST localhost:3000/api/extract \
  -H 'content-type: application/json' \
  -d '{"url":"http://127.0.0.1:8080/v/abc123"}'
```

## Deploy to Vercel

1. Push this folder to a Git repo.
2. [vercel.com/new](https://vercel.com/new) → **Import** → framework auto-detected (Next.js) → **Deploy**. No config needed.
3. Optional env var `UCSHARE_ALLOWED_HOSTS` (default `uc-share.com`) — comma-separated allowlist of page hosts the extractor may fetch.

Or with the CLI:

```bash
npm i -g vercel && vercel --prod
```

### Production notes

- Both routes declare `runtime = "nodejs"` and `dynamic = "force-dynamic"`. The proxy route is runtime-agnostic — flip `runtime` to `"edge"` for CDN-edge streaming if you prefer.
- `maxDuration = 60` is set on the proxy; adjust to your Vercel plan's function limit (Hobby: 60 s, Pro: up to 300 s / Fluid). Very large files stream fine — the timeout governs total transfer time.
- `.m3u8` results can't play in a native `<video>` element; the UI detects this and shows copy/download actions instead.
- `next/font/google` fonts are inlined at build time; no runtime CDN calls.

## Legal

Use only for content you own or have explicit permission to access. This project is a technical demo of serverless scraping patterns.
