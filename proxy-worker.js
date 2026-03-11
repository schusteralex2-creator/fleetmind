/**
 * FleetMind Fetch Proxy — Cloudflare Worker
 *
 * Routes: GET /proxy?url=<encoded-url>
 *
 * Fetches the target URL server-side (bypassing browser CORS restrictions)
 * and streams the response back to the client.
 *
 * Security: only fetches from the ALLOWED_DOMAINS list below.
 */

// ─── Domain Allowlist ────────────────────────────────────────────────────────
// Add any manufacturer or document hosting domains your fleet uses.
// Wildcards are supported: "*.cat.com" matches any subdomain of cat.com.

const ALLOWED_DOMAINS = [
  // Manufacturer documentation sites
  "*.cat.com",
  "*.caterpillar.com",
  "*.komatsu.com",
  "*.deere.com",
  "*.johndeer.com",
  "*.volvoce.com",
  "*.hitachicm.com",
  "*.doosan.com",
  "*.liebherr.com",
  "*.jcb.com",
  "*.cnh.com",          // Case / New Holland
  "*.casece.com",
  "*.newholland.com",
  "*.manitou.com",
  "*.terex.com",

  // Document hosting
  "drive.google.com",
  "dl.dropboxusercontent.com",
  "*.s3.amazonaws.com",
  "*.s3.us-east-1.amazonaws.com",
  "*.blob.core.windows.net",   // Azure Blob Storage
  "*.sharepoint.com",

  // Generic PDF/doc CDNs — add your internal doc server here
  // "docs.yourcompany.com",
];

// ─── CORS Headers ────────────────────────────────────────────────────────────
// The origin below should match your Cloudflare Pages domain.
// Change "*" to your exact Pages URL in production for tighter security,
// e.g. "https://fleetmind.pages.dev" or "https://fleetmind.yourcompany.com"

const CORS_ORIGIN = "*";

const corsHeaders = {
  "Access-Control-Allow-Origin": CORS_ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ─── Domain Matching ─────────────────────────────────────────────────────────

function domainAllowed(hostname) {
  return ALLOWED_DOMAINS.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const base = pattern.slice(2);
      return hostname === base || hostname.endsWith("." + base);
    }
    return hostname === pattern;
  });
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    const reqUrl = new URL(request.url);
    const targetRaw = reqUrl.searchParams.get("url");

    if (!targetRaw) {
      return new Response(
        JSON.stringify({ error: "Missing ?url= parameter" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate and parse the target URL
    let targetUrl;
    try {
      targetUrl = new URL(decodeURIComponent(targetRaw));
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid URL" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Enforce HTTPS only
    if (targetUrl.protocol !== "https:") {
      return new Response(
        JSON.stringify({ error: "Only HTTPS URLs are supported" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check against allowlist
    if (!domainAllowed(targetUrl.hostname)) {
      return new Response(
        JSON.stringify({
          error: `Domain not allowed: ${targetUrl.hostname}. Add it to ALLOWED_DOMAINS in proxy-worker.js.`,
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch the target resource
    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        headers: {
          // Mimic a browser request so servers don't block us
          "User-Agent": "Mozilla/5.0 (compatible; FleetMind/1.0)",
          Accept: "application/pdf,text/html,application/xhtml+xml,*/*",
        },
        redirect: "follow",
        cf: { cacheTtl: 3600 }, // Cache for 1 hour at Cloudflare edge
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: `Fetch failed: ${err.message}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!upstream.ok) {
      return new Response(
        JSON.stringify({ error: `Upstream returned HTTP ${upstream.status}` }),
        { status: upstream.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Stream the response back, injecting CORS headers
    const responseHeaders = new Headers(upstream.headers);
    Object.entries(corsHeaders).forEach(([k, v]) => responseHeaders.set(k, v));

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  },
};
