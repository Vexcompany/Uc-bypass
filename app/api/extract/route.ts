import { NextRequest, NextResponse } from "next/server";
import { extractFromPage, ExtractionError } from "@/lib/extract";
import { parsePageUrl } from "@/lib/shared";

/**
 * POST /api/extract  — resolve a uc-share.com / drive.uc.cn page into direct media URL(s).
 * Supports single-file shares and folder shares (lists files via UC Drive API).
 *
 * Runs on the Vercel Serverless (Node.js) runtime. No external binaries:
 * UC API + fetch + cheerio/regex fallback (see lib/extract.ts).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  // ---- Parse & validate input -------------------------------------
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Request body must be valid JSON: { \"url\": \"…\" }" },
      { status: 400 },
    );
  }

  const bodyObj = body as { url?: unknown; passcode?: unknown };
  const raw = typeof bodyObj?.url === "string" ? bodyObj.url.trim() : "";
  const passcode =
    typeof bodyObj?.passcode === "string" ? bodyObj.passcode.trim() : undefined;

  if (!raw) {
    return NextResponse.json(
      { success: false, error: "Missing required field: url." },
      { status: 400 },
    );
  }

  const pageUrl = parsePageUrl(raw);
  if (!pageUrl) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Invalid URL. Only http(s) links on uc-share.com, drive.uc.cn, fast.uc.cn (or their subdomains) are supported.",
      },
      { status: 400 },
    );
  }

  // ---- Fetch + multi-tier extraction ------------------------------
  try {
    const media = await extractFromPage(pageUrl, { passcode });

    let sourceDomain = pageUrl.hostname;
    try {
      sourceDomain = new URL(media.directUrl).hostname;
    } catch {
      /* fall back to page host */
    }

    return NextResponse.json({
      success: true,
      title: media.title,
      directUrl: media.directUrl,
      mediaType: media.mediaType, // 'video' | 'file'
      size: media.size,
      resolution: media.resolution,
      method: media.method,
      sourceDomain,
      isFolder: media.isFolder ?? false,
      files: media.files ?? undefined,
    });
  } catch (err) {
    if (err instanceof ExtractionError) {
      return NextResponse.json(
        { success: false, error: err.message },
        { status: err.status >= 400 && err.status <= 599 ? err.status : 422 },
      );
    }
    console.error("[extract] unexpected error:", err);
    return NextResponse.json(
      {
        success: false,
        error: "Unexpected server error while resolving the page. Please try again.",
      },
      { status: 500 },
    );
  }
}

/** Tiny self-describing GET for curious API consumers. */
export async function GET() {
  return NextResponse.json({
    endpoint: "POST /api/extract",
    body: {
      url: "https://uc-share.com/s/<share-id> or https://drive.uc.cn/s/<share-id>",
      passcode: "optional share passcode",
    },
    response: {
      success: "boolean",
      title: "string?",
      directUrl: "string?",
      mediaType: "'video' | 'file'?",
      isFolder: "boolean?",
      files: "Array<{ name, directUrl, mediaType, size? }>?",
      error: "string?",
    },
  });
}
