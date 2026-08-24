#!/usr/bin/env node
/**
 * Mock uc-share.com page server — lets you test the extractor end-to-end
 * without a real share link.
 *
 *   1. node scripts/mock-ucshare.mjs            (serves on :8080)
 *   2. Add `127.0.0.1  mock.test` to /etc/hosts  (or run UCSHARE_ALLOWED_HOSTS="mock.test" dev server)
 *   3. Extract:  curl -X POST localhost:3000/api/extract \
 *                  -H 'content-type: application/json' \
 *                  -d '{"url":"http://mock.test:8080/v/abc123"}'
 *
 * The fixture exercises every extraction tier:
 *   - <video><source src> tag
 *   - og:video / og:title / og:video:width meta tags
 *   - JWplayer-style inline script config
 *   - a raw JSON blob with sources[]
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8080);

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Big Buck Bunny Trailer — UC Share Mock</title>
<meta property="og:title" content="Big Buck Bunny Trailer (mock)">
<meta property="og:video" content="https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4">
<meta property="og:video:width" content="640">
<meta property="og:video:height" content="360">
</head>
<body>
<h1>Shared file: Big Buck Bunny</h1>
<p>Size: 1.0 MB · MP4 · 640x360</p>

<video controls width="640" height="360">
  <source src="https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4" type="video/mp4">
  Your browser does not support the video tag.
</video>

<script>
  jwplayer("player").setup({
    file: "https:\\/\\/test-videos.co.uk\\/vids\\/bigbuckbunny\\/mp4\\/h264\\/360\\/Big_Buck_Bunny_360_10s_1MB.mp4",
    image: "https://example.com/poster.jpg"
  });
</script>

<script>
  window.__APP_STATE__ = {
    media: {
      sources: [
        { "src": "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4", "type": "video/mp4" },
        { "src": "https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4", "type": "video/mp4" }
      ]
    }
  };
</script>

<a class="btn" href="/dl/ticket-abc123/BigBuckBunny.zip" data-href="https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4">Download</a>
</body>
</html>`;

createServer((req, res) => {
  if (req.url?.startsWith("/dl/")) {
    res.writeHead(302, { Location: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4" });
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(HTML);
}).listen(PORT, () => {
  console.log(`[mock-ucshare] fixture page listening on http://127.0.0.1:${PORT}/v/abc123`);
});
