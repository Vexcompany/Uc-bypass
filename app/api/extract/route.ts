import { NextRequest, NextResponse } from "next/server";
import { extractFromPage, ExtractionError } from "@/lib/extract";
import { parsePageUrl } from "@/lib/shared";

/**
 * POST /api/extract  — resolve a uc-share.com page into a direct media URL.
 *
 * Runs on the Vercel Serverless (Node.js) runtime. No external binaries:
 * fetching is plain `fetch`, parsing is cheerio + regex (see lib/extract.ts).
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

  const raw = typeof (body as { url?: unknown })?.url === "string"
    ? ((body as { url: string }).url).trim()
    : "";

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
          "Invalid URL. Only http(s) links on uc-share.com (or its subdomains) are supported.",
      },
      { status: 400 },
    );
  }

  // ---- Fetch + multi-tier extraction ------------------------------
  try {
    const media = await extractFromPage(pageUrl);

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
    body: { url: "https://uc-share.com/<share-path>" },
    response: {
      success: "boolean",
      title: "string?",
      directUrl: "string?",
      mediaType: "'video' | 'file'?",
      error: "string?",
    },
  });
}
