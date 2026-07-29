const ALLOWED_HOSTS = new Set([
  "googlevideo.com",
  "youtube.com",
  "ytimg.com",
]);

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = (env.ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);
    const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0] || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(corsOrigin) });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "Method not allowed" }, 405, corsOrigin);
    }

    const incomingUrl = new URL(request.url);
    const target = incomingUrl.searchParams.get("url");
    if (!target) {
      return json({ error: "Missing ?url=" }, 400, corsOrigin);
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return json({ error: "Invalid target URL" }, 400, corsOrigin);
    }

    if (!isAllowedTarget(targetUrl)) {
      return json({ error: "Target host is not allowed" }, 403, corsOrigin);
    }

    const range = request.headers.get("Range");
    const upstreamHeaders = new Headers({
      "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0 PB Media Fetch",
      "Accept": request.headers.get("Accept") || "*/*",
    });
    if (range) upstreamHeaders.set("Range", range);

    const upstream = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: upstreamHeaders,
    });

    const responseHeaders = new Headers(upstream.headers);
    for (const [key, value] of Object.entries(corsHeaders(corsOrigin))) {
      responseHeaders.set(key, value);
    }
    responseHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
};

export function isAllowedTarget(url) {
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return Array.from(ALLOWED_HOSTS).some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "Range,Content-Type,Accept",
    "Access-Control-Expose-Headers": "Content-Length,Content-Range,Accept-Ranges,Content-Type",
    "Vary": "Origin",
  };
}

function json(payload, status, origin) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
    },
  });
}
