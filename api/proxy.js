// Vercel Serverless Function: /api/proxy.js
// Ultra-lightweight M3U8 manifest-only proxy (~0 MB Fast Origin Transfer).
// Rewrites relative playlist segment paths to direct CDN URLs so heavy video chunks NEVER touch Vercel.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const targetUrl = req.query.url;
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return res.status(400).json({ error: "Invalid stream URL" });
  }

  const lowerUrl = targetUrl.toLowerCase();
  const isMediaSegment = /\.(ts|m4s|mp4|aac|mp3)(\?|$)/i.test(lowerUrl);

  // Block heavy video segment proxying on Vercel to protect the 10 GB Fast Origin Transfer limit;
  // redirect client directly to the origin CDN instead.
  if (isMediaSegment) {
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.redirect(302, targetUrl);
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Lavf/58.76.100",
        "Accept": "*/*"
      }
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send("Upstream error");
    }

    const finalUrl = upstream.url || targetUrl;
    const baseDir = finalUrl.substring(0, finalUrl.lastIndexOf("/") + 1);
    const originMatch = finalUrl.match(/^(https?:\/\/[^\/]+)/i);
    const baseOrigin = originMatch ? originMatch[1] : "";

    const bodyText = await upstream.text();

    // Rewrite every line inside the .m3u8 manifest:
    // - Sub-playlists (.m3u8) stay routed through /api/proxy?mode=manifest
    // - Heavy video chunks (.ts, .m4s, .aac) point DIRECTLY to the real stream CDN!
    const rewritten = bodyText
      .split(/\r?\n/)
      .map((rawLine) => {
        const line = rawLine.trim();
        if (!line) return rawLine;

        // Handle URI="..." attributes inside #EXT-X-KEY or #EXT-X-MEDIA tags
        if (line.startsWith("#")) {
          return rawLine.replace(/URI="([^"]+)"/gi, (match, uri) => {
            const absUri = resolveUrl(uri, baseDir, baseOrigin);
            if (/\.m3u8(\?|$)/i.test(absUri)) {
              return `URI="/api/proxy?mode=manifest&url=${encodeURIComponent(absUri)}"`;
            }
            return `URI="${absUri}"`;
          });
        }

        const absUrl = resolveUrl(line, baseDir, baseOrigin);
        if (/\.m3u8(\?|$)/i.test(absUrl)) {
          return `/api/proxy?mode=manifest&url=${encodeURIComponent(absUrl)}`;
        }
        return absUrl;
      })
      .join("\n");

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(rewritten);
  } catch (err) {
    return res.status(502).json({ error: "Failed to fetch manifest" });
  }
}

function resolveUrl(rel, baseDir, baseOrigin) {
  if (/^https?:\/\//i.test(rel)) return rel;
  if (rel.startsWith("//")) return "https:" + rel;
  if (rel.startsWith("/")) return baseOrigin + rel;
  return baseDir + rel;
}
