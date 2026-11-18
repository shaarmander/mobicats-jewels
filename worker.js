const previewPath = /^\/s\/([a-f0-9]{64})(\/image\.jpg)?$/;
const fallbackImage = "/assets/brand/ring-preview.jpg";
const maxBytes = 160 * 1024;
const previewLifetime = 90 * 86400;

function validJpeg(bytes) {
  if (
    bytes.length < 16 ||
    bytes[0] !== 255 ||
    bytes[1] !== 216 ||
    bytes.at(-2) !== 255 ||
    bytes.at(-1) !== 217
  )
    return false;
  let offset = 2;
  while (offset + 8 < bytes.length && bytes[offset] === 255) {
    const marker = bytes[offset + 1];
    const length = bytes[offset + 2] * 256 + bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) return false;
    if (marker === 192 || marker === 194) {
      const h = bytes[offset + 5] * 256 + bytes[offset + 6];
      const w = bytes[offset + 7] * 256 + bytes[offset + 8];
      return length >= 11 && Math.min(h, w) > 0 && Math.max(h, w) <= 960;
    }
    offset += 2 + length;
  }
  return false;
}

async function savePreview(request, env, origin) {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (request.headers.get("Origin") !== origin)
    return new Response(null, { status: 403 });
  if (request.headers.get("Content-Type") !== "image/jpeg")
    return new Response(null, { status: 415 });
  const length = Number(request.headers.get("Content-Length"));
  if (!(length > 0 && length <= maxBytes))
    return new Response(null, { status: 413 });
  const { success } = await env.SHARE_LIMIT.limit({
    key: request.headers.get("CF-Connecting-IP") || "local",
  });
  if (!success) return new Response(null, { status: 429 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length !== length || !validJpeg(bytes))
    return new Response(null, { status: 400 });
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const id = Array.from(new Uint8Array(digest), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
  await env.PREVIEWS.put(id, bytes, { expirationTtl: previewLifetime });
  return Response.json({ id }, { headers: { "Cache-Control": "no-store" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (
      url.protocol === "http:" &&
      url.hostname !== "localhost" &&
      url.hostname !== "127.0.0.1"
    ) {
      url.protocol = "https:";
      return Response.redirect(url.href, 308);
    }
    if (url.pathname === "/api/share")
      return savePreview(request, env, url.origin);
    const share = previewPath.exec(url.pathname);
    if (!share) return env.ASSETS.fetch(request);
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 405 });
    if (share[2]) {
      const key = new Request(url.origin + url.pathname);
      let image = await caches.default.match(key);
      if (!image) {
        const data = await env.PREVIEWS.get(share[1], "arrayBuffer");
        if (!data)
          return new Response(null, {
            status: 302,
            headers: { Location: fallbackImage, "Cache-Control": "no-store" },
          });
        image = new Response(data, {
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "public, max-age=86400",
            "X-Content-Type-Options": "nosniff",
          },
        });
        ctx.waitUntil(caches.default.put(key, image.clone()));
      }
      return request.method === "HEAD" ? new Response(null, image) : image;
    }
    const page = await env.ASSETS.fetch(new URL("/", url.origin));
    const photo = url.origin + url.pathname + "/image.jpg";
    const imageTag = {
      element(tag) {
        tag.setAttribute("content", photo);
      },
    };
    const tags = new HTMLRewriter()
      .on('meta[property="og:image"]', imageTag)
      .on('meta[name="twitter:image"]', imageTag)
      .on('meta[property="og:url"]', {
        element(tag) {
          tag.setAttribute("content", url.href);
        },
      });
    const result = tags.transform(page);
    // Each URL carries its own ring state. Do not reuse the homepage ETag.
    result.headers.delete("etag");
    return request.method === "HEAD" ? new Response(null, result) : result;
  },
};
