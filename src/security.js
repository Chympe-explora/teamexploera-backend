/**
 * security.js — the site's "front door lock" for every public request.
 * -----------------------------------------------------------------------
 * Runs once, right at the top of index.js's fetch(), before any route
 * handler ever sees the request. Nothing here changes the site's normal
 * behavior for a normal visitor — it only turns on when a request looks
 * like a normal visitor wouldn't (or couldn't) have sent it.
 *
 * What it does:
 *   1. IP BLOCKLIST     — an IP that's already been flagged is refused
 *                          immediately (403), before it can touch KV,
 *                          Telegram, or anything else.
 *   2. ATTACK PATTERNS   — the path/query/headers of every request are
 *                          checked against a short list of unmistakable
 *                          "someone is probing this Worker" signatures
 *                          (path traversal, SQLi/XSS payload markers,
 *                          scanner/exploit-kit user agents, common CMS/
 *                          secrets-file probes that this project could
 *                          never legitimately serve — this is a
 *                          Cloudflare Worker, it has no /wp-admin, no
 *                          .env file on disk, no phpMyAdmin).
 *   3. RATE LIMITING     — a sliding request-count cap per IP, tighter
 *                          on endpoints that write data (submit a
 *                          booking, post a rating, send an ERA AI
 *                          message) than on ones that only read public
 *                          content.
 *   4. BODY-SIZE GUARD   — refuses absurdly large request bodies before
 *                          they're ever parsed as JSON/formData.
 *   5. STRIKES + AUTO-BLOCK — each violation adds a "strike" against
 *                          the IP. Enough strikes in a short window and
 *                          the IP is auto-blocked for a cooldown period
 *                          — no admin action needed, but the admin is
 *                          told about it (see below).
 *   6. ADMIN ALERTS      — the first time an IP is blocked, or the
 *                          first attack-pattern hit from an IP in a
 *                          15-minute window, a Telegram message is sent
 *                          to TELEGRAM_ADMIN_CHAT_ID so a human sees it
 *                          in real time. Alerts are throttled per-IP so
 *                          a determined attacker can't be used to spam
 *                          the admin chat into being useless.
 *
 * Storage: reuses the existing BOOKINGS KV namespace (no new bindings,
 * no wrangler.toml changes, no redeploy surprises). Keys are namespaced
 * under `sec:` and all carry short expirationTtl values so this never
 * grows unbounded.
 *
 * Nothing here ever blocks POST /telegram-webhook — that endpoint is
 * already protected by TELEGRAM_WEBHOOK_SECRET (a value only Telegram's
 * servers know) and comes from Telegram's own shared IP ranges, which a
 * naive per-IP rate limit could otherwise choke under bot-admin traffic.
 */

import { corsHeaders } from "./booking.js";

// ---------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------

export function getClientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown"
  );
}

// Mobile carriers commonly hand a device a stable /64 IPv6 prefix but
// let the low 64 bits (the "interface identifier") rotate — SLAAC
// privacy/temporary addresses (RFC 4941), or simply a new address after
// a tower handoff. That means the SAME visitor can show up as a
// different full IPv6 address from one request to the next, sometimes
// even a few seconds apart. Keying blocks/strikes/rate-limit-exemptions
// off the full address made all three look broken for mobile visitors:
// an admin would exempt or unblock one exact address, and the very next
// request — from the same phone, same network — would arrive under a
// different one and get rate-limited/blocked all over again.
//
// The fix: normalize every IPv6 address down to its /64 network prefix
// (the first 4 groups) before using it as a KV key. IPv4 addresses are
// returned unchanged. This is a simplification (it assumes the first 4
// groups are never themselves compressed away by "::"), which holds for
// every real-world global-unicast address — those never start with a
// run of zero groups — so it's safe for this purpose.
export function normalizeIp(ip) {
  if (!ip || ip.indexOf(":") === -1) return ip; // IPv4 (or "unknown") — no change
  const groups = ip
    .split(":")
    .filter((g) => g !== "") // drop empty parts from "::" compression
    .map((g) => g.toLowerCase().replace(/^0+(?=[0-9a-f])/, "")); // "0192" -> "192", so a
  // manually-typed address (leading zeros, mixed case) still lands on
  // the same key as the canonical form Cloudflare sends.
  if (groups.length < 4) return ip; // too short/odd shape to safely take a /64 — fall back to exact match
  return groups.slice(0, 4).join(":") + "::";
}

// Constant-time-ish string compare — prevents an attacker from timing
// how many leading characters of a guessed secret matched a byte-by-byte
// `===` comparison. Used for ADMIN_API_SECRET / webhook secret checks.
export function secureCompare(a, b) {
  const sa = String(a == null ? "" : a);
  const sb = String(b == null ? "" : b);
  if (sa.length !== sb.length) {
    // Still walk a fixed number of comparisons so a length mismatch
    // doesn't return measurably faster than a same-length mismatch.
    let dummy = 0;
    for (let i = 0; i < Math.max(sa.length, sb.length, 32); i++) dummy |= i;
    return false;
  }
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

// Extra headers applied to EVERY response leaving this Worker.
export function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    // This Worker only ever returns JSON, images, or video — never
    // HTML it generated from a template, so a strict CSP here costs
    // nothing and blocks nothing legitimate.
    "Content-Security-Policy": "default-src 'none'",
  };
}

export function withSecurityHeaders(response, env) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(securityHeaders())) headers.set(k, v);
  // CORS headers must be present on EVERY response this Worker returns,
  // including ones short-circuited by securityGate() (blocked IP, rate
  // limit, attack-pattern match) — those are built with raw `new
  // Response(...)` in json403/json429/json413 below and never went
  // through booking.js's json() helper, so they arrive here with no
  // Access-Control-Allow-Origin header. Without it, the browser's
  // fetch() throws a network error before the frontend ever sees the
  // real status/reason, which is exactly what shows up to visitors as
  // "network error" / "receipt upload failed" even though the Worker
  // responded normally. Adding it here, once, for every response,
  // closes that gap regardless of which code path built the response.
  if (env) {
    for (const [k, v] of Object.entries(corsHeaders(env))) headers.set(k, v);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// ---------------------------------------------------------------------
// KV-backed sliding counters (rate limiting + strikes)
// ---------------------------------------------------------------------

// Increments a counter keyed by `key`, expiring after `windowSeconds`,
// and returns the count AFTER this increment. Not perfectly atomic
// (Workers KV has no native INCR), but good enough for abuse detection
// at this traffic scale — a missed race just means a request or two
// slips through, never a security hole.
//
// Fails OPEN (returns 0, i.e. "not over limit") if KV throws for any
// reason — e.g. the daily write-quota being exhausted on the free
// plan. Rate limiting is a safety net, not core functionality: it
// should never be the reason a real visitor's request (or the whole
// site) goes down.
async function bump(env, key, windowSeconds) {
  try {
    const raw = await env.BOOKINGS.get(key);
    const n = (parseInt(raw, 10) || 0) + 1;
    await env.BOOKINGS.put(key, String(n), { expirationTtl: windowSeconds });
    return n;
  } catch {
    return 0;
  }
}

// limit: max requests allowed inside windowSeconds. Returns true if the
// request should be ALLOWED (i.e. under the limit).
async function rateLimit(env, bucket, ip, limit, windowSeconds) {
  const key = `sec:rl:${bucket}:${normalizeIp(ip)}`;
  const n = await bump(env, key, windowSeconds);
  return n <= limit;
}

// Per-route limits. Anything not listed falls back to DEFAULT_LIMIT.
// [bucket name, limit, windowSeconds]
const ROUTE_LIMITS = [
  [/^\/api\/submit$/, 8, 300], // a real booking submission, tightly capped
  [/^\/api\/refund-request$/, 8, 300],
  [/^\/api\/receipt$/, 15, 300], // file uploads
  [/^\/api\/draft$/, 60, 60], // fires on every keystroke — generous
  [/^\/api\/paynow$/, 20, 300],
  [/^\/api\/ratings$/, 6, 3600], // one honest visitor rarely rates twice an hour
  [/^\/api\/reviews$/, 6, 3600],
  [/^\/api\/era\/message$/, 30, 60],
  [/^\/api\/era\/typing$/, 90, 60],
  [/^\/api\/calculate-price$/, 60, 60],
  [/^\/api\/visit$/, 60, 60],
  [/^\/api\/tap$/, 60, 60],
  [/^\/api\/admin\//, 20, 60], // secret-protected, but still capped against brute force
];
const DEFAULT_LIMIT = [120, 60];
// A hard global ceiling per IP across ALL endpoints combined, so no
// combination of individually-under-limit calls can still hammer the
// Worker (and, downstream, Telegram's API) into the ground.
const GLOBAL_LIMIT = [240, 60];

function limitFor(pathname) {
  for (const [re, limit, windowSeconds] of ROUTE_LIMITS) {
    if (re.test(pathname)) return [limit, windowSeconds];
  }
  return DEFAULT_LIMIT;
}

// ---------------------------------------------------------------------
// Blocklist
// ---------------------------------------------------------------------

const BLOCK_KEY = (ip) => `sec:blocked:${ip}`;
const STRIKE_KEY = (ip) => `sec:strikes:${ip}`;
const ALERT_THROTTLE_KEY = (ip, kind) => `sec:alerted:${kind}:${ip}`;

export async function isBlocked(env, ip) {
  return !!(await env.BOOKINGS.get(BLOCK_KEY(normalizeIp(ip))));
}

async function blockIp(env, ip, hours, reason) {
  await env.BOOKINGS.put(BLOCK_KEY(normalizeIp(ip)), reason || "auto-blocked", { expirationTtl: Math.round(hours * 3600) });
}

// Adds `weight` strikes against an IP (expiring after 1h) and returns
// the running total. Crossing STRIKE_THRESHOLD triggers an auto-block.
const STRIKE_THRESHOLD = 6;
const AUTO_BLOCK_HOURS = 24;

async function addStrikes(env, ip, weight, reason) {
  const normalized = normalizeIp(ip);
  try {
    const key = STRIKE_KEY(normalized);
    const raw = await env.BOOKINGS.get(key);
    const n = (parseInt(raw, 10) || 0) + weight;
    await env.BOOKINGS.put(key, String(n), { expirationTtl: 3600 });
    if (n >= STRIKE_THRESHOLD) {
      await blockIp(env, normalized, AUTO_BLOCK_HOURS, reason);
      return { blocked: true, strikes: n };
    }
    return { blocked: false, strikes: n };
  } catch {
    return { blocked: false, strikes: 0 };
  }
}

// ---------------------------------------------------------------------
// Attack-pattern detection
// ---------------------------------------------------------------------

// Paths that a Cloudflare Worker like this one could NEVER legitimately
// need to serve. A hit on any of these is not a false positive — it's a
// vulnerability scanner or exploit kit walking a checklist.
const PROBE_PATH_RE =
  /(\.env($|[?#])|\/wp-(admin|login|content|json)|\/xmlrpc\.php|\/\.git\/|\/phpmyadmin|\/\.aws\/|\/\.ssh\/|\/config\.php|\/administrator\/|\/\.well-known\/security\.txt$|\/actuator\/|\/vendor\/phpunit|\/\.docker|\/\.htaccess|\/server-status|\/console\/|\/debug\/default\/view)/i;

// Classic injection/traversal payload markers. These are checked
// against the full decoded URL (path + query) and, for JSON bodies, the
// raw body text — deliberately broad because a false positive here just
// costs a strike (recoverable), while a false negative lets a real
// attack through.
const PAYLOAD_RE =
  /(<script[\s>]|javascript:|onerror\s*=|onload\s*=|union\s+select|select\s+.{1,40}\s+from|drop\s+table|insert\s+into|\bexec(\s|\()|\.\.\/\.\.\/|\/etc\/passwd|\$\{jndi:|<\?php|base64_decode\(|eval\(|document\.cookie)/i;

// User agents that identify themselves as scanners, or the empty/near-
// empty UA a lot of scripted attack tooling sends. A real browser or
// this project's own frontend always sends a normal UA string.
const BAD_UA_RE =
  /(sqlmap|nikto|nessus|acunetix|nuclei|masscan|zgrab|dirbuster|gobuster|wpscan|fimap|libwww-perl|python-requests\/|curl\/7\.[0-6]|scrapy|havij)/i;

function looksLikeAttack(request, url, bodyText) {
  const pathAndQuery = url.pathname + url.search;
  if (PROBE_PATH_RE.test(pathAndQuery)) return "known-probe-path";
  if (PAYLOAD_RE.test(decodeSafely(pathAndQuery))) return "injection-payload-in-url";
  const ua = request.headers.get("user-agent") || "";
  if (BAD_UA_RE.test(ua)) return "scanner-user-agent";
  if (!ua) return "missing-user-agent";
  if (bodyText && PAYLOAD_RE.test(bodyText)) return "injection-payload-in-body";
  return null;
}

function decodeSafely(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------
// Admin alerting
// ---------------------------------------------------------------------

async function alertAdmin(env, ctx, ip, title, detail) {
  const chatId = env.TELEGRAM_ADMIN_CHAT_ID || env.TELEGRAM_CHAT_ID;
  if (!chatId || !env.TELEGRAM_BOT_TOKEN) return;
  const text =
    `🚨 <b>Security alert</b>\n` +
    `<b>${escapeHtml(title)}</b>\n` +
    `IP: <code>${escapeHtml(ip)}</code>\n` +
    (detail ? `${escapeHtml(detail)}\n` : "") +
    `<i>${new Date().toISOString()}</i>`;
  const send = fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  }).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(send);
  else await send;
}

// Only alerts once per IP per `kind` per throttle window, so a repeat
// offender who's already been blocked doesn't flood the admin chat.
async function alertOnce(env, ctx, ip, kind, title, detail, throttleSeconds) {
  const key = ALERT_THROTTLE_KEY(ip, kind);
  const already = await env.BOOKINGS.get(key);
  if (already) return;
  await env.BOOKINGS.put(key, "1", { expirationTtl: throttleSeconds });
  await alertAdmin(env, ctx, ip, title, detail);
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------
// Body size guard
// ---------------------------------------------------------------------

const MAX_JSON_BYTES = 64 * 1024; // 64KB — every JSON endpoint here is a small form
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB — receipt photos/docs (Telegram's own cap is ~20MB for bots)

function bodyTooLarge(request, url) {
  const len = parseInt(request.headers.get("content-length") || "0", 10);
  if (!len) return false; // no declared length — let it through, formData()/json() will still bound memory use
  const isUpload = url.pathname === "/api/receipt";
  return len > (isUpload ? MAX_UPLOAD_BYTES : MAX_JSON_BYTES);
}

// ---------------------------------------------------------------------
// The gate — call this first, at the top of fetch(). Returns a Response
// to short-circuit the request (block it), or null to let it proceed
// normally.
// ---------------------------------------------------------------------

const EXEMPT_PATHS = new Set(["/telegram-webhook", "/api/whoami"]);

// Trusted admin/tester IPs — set as a comma-separated list in
// wrangler.toml's [vars] block, e.g.:
//   ADMIN_IPS = "203.0.113.45,198.51.100.9"
// Any request from one of these IPs skips the entire security gate
// below (blocklist, attack-pattern check, rate limiting) — added
// because the admin's own repeated testing was tripping the same
// strike system built for abusive traffic and getting auto-blocked
// for 24h. If your IP changes (common on home broadband), update this
// list and redeploy.
function isAllowlistedIp(env, ip) {
  const list = String(env.ADMIN_IPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(ip);
}

// Primary admin bypass: a shared secret in the `x-admin-secret` header,
// checked with the same constant-time compare used everywhere else
// (see secureCompare above). This works from ANY IP, on ANY network,
// forever — unlike ADMIN_IPS, it doesn't depend on a mobile connection
// having a stable public IP (mobile carriers commonly use CGNAT, where
// the IP a site sees can differ from what whatismyipaddress.com shows,
// and can change per-connection). ADMIN_IPS is kept below as a
// convenience fallback only — it is never the only way in anymore, so
// a stale/wrong ADMIN_IPS value can no longer lock the admin out.
function isAdminRequest(env, request, ip) {
  const provided = request.headers.get("x-admin-secret") || "";
  if (env.ADMIN_API_SECRET && secureCompare(provided, env.ADMIN_API_SECRET)) return true;
  return isAllowlistedIp(env, ip);
}

export async function securityGate(request, env, ctx) {
  const url = new URL(request.url);

  if (EXEMPT_PATHS.has(url.pathname)) return null;

  const ip = normalizeIp(getClientIp(request));

  // 0. Trusted admin — bypass every check below entirely. Checked via
  // header secret first, IP allowlist second (see isAdminRequest above).
  if (isAdminRequest(env, request, ip)) return null;

  // 1. Already blocked?
  if (await isBlocked(env, ip)) {
    return json403("blocked");
  }

  // 2. Body size guard (cheap, header-only check — before we ever
  //    buffer/parse the body).
  if (bodyTooLarge(request, url)) {
    const r = await addStrikes(env, ip, 2, "oversized request body");
    await alertOnce(env, ctx, ip, "oversized-body", "Oversized request body", `path: ${url.pathname}`, 900);
    if (r.blocked) await alertOnce(env, ctx, ip, "blocked", "IP auto-blocked", `reason: oversized request body (24h block)`, 900);
    return json413();
  }

  // 3. Attack-pattern check on path/query/UA. (Body-content payload
  //    scanning happens per-handler is intentionally skipped here to
  //    avoid double-consuming the body stream; URL + UA covers the
  //    overwhelming majority of real-world probe traffic.)
  const attackKind = looksLikeAttack(request, url, null);
  if (attackKind && attackKind !== "missing-user-agent") {
    const r = await addStrikes(env, ip, 3, `attack pattern: ${attackKind}`);
    await alertOnce(env, ctx, ip, "attack", "Attack pattern detected", `kind: ${attackKind}\npath: ${url.pathname}${url.search}`, 900);
    if (r.blocked) await alertOnce(env, ctx, ip, "blocked", "IP auto-blocked", `reason: ${attackKind} (24h block)`, 900);
    return json403("forbidden");
  }
  if (attackKind === "missing-user-agent") {
    // Weak signal alone (some legitimate HTTP clients omit UA) — strike
    // lightly, don't block on this alone, don't alert.
    await addStrikes(env, ip, 1, "missing user-agent");
  }

  // 4. Rate limiting — per-route only. (Previously also had a separate
  // "global" counter, but that meant 2 KV writes per request — burning
  // through Cloudflare's free-plan 1,000 writes/day cap twice as fast
  // for no real security benefit over the per-route limits below,
  // which already cap the endpoints worth capping tightly, e.g.
  // /api/submit at 8 per 5 minutes. If you're on Workers Paid (10M
  // writes/day), feel free to re-add the global check — see git
  // history for the old code.)
  //
  // An IP an admin has explicitly exempted (see setRateLimitExempt —
  // requires a real phone number attached, so it's always tied to an
  // identified person, never a bare "trust this IP") skips ONLY this
  // step. Steps 1–3 above (blocklist, body-size guard, attack-pattern
  // detection) still run for it exactly as normal — an exemption lifts
  // the request-count cap for a genuine, busy visitor, it never opens a
  // hole for malware, brute-force tools, or scanners.
  const exemption = await isRateLimitExempt(env, ip);
  if (!exemption) {
    const [limit, windowSeconds] = limitFor(url.pathname);
    const underRoute = await rateLimit(env, url.pathname, ip, limit, windowSeconds);
    if (!underRoute) {
      const r = await addStrikes(env, ip, 1, `rate limit on ${url.pathname}`);
      await alertOnce(env, ctx, ip, "ratelimit-route", "Rate limit exceeded", `path: ${url.pathname}`, 900);
      if (r.blocked) await alertOnce(env, ctx, ip, "blocked", "IP auto-blocked", `reason: repeated rate-limit violations (24h block)`, 900);
      return json429();
    }
  }

  return null; // clean — proceed to normal routing
}

function json403(error) {
  return new Response(JSON.stringify({ ok: false, error: error || "forbidden" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}
function json429() {
  return new Response(JSON.stringify({ ok: false, error: "too many requests" }), {
    status: 429,
    headers: { "content-type": "application/json", "Retry-After": "60" },
  });
}
function json413() {
  return new Response(JSON.stringify({ ok: false, error: "request too large" }), {
    status: 413,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------
// Honeypot helper — a hidden form field no real visitor's browser would
// ever fill in, but a dumb auto-fill bot often will. See booking.js's
// handleSubmit for usage, and live-content.js on the frontend for the
// hidden field itself.
// ---------------------------------------------------------------------

export function honeypotTripped(data) {
  return !!(data && typeof data === "object" && String(data.website_url || "").trim().length > 0);
}

// Manual admin controls, wired to /api/admin/security-status and
// /api/admin/unblock in index.js (both require x-admin-secret, same as
// the existing /api/admin/reset-images endpoint).
export async function adminUnblock(env, ip) {
  const normalized = normalizeIp(ip);
  await env.BOOKINGS.delete(BLOCK_KEY(normalized));
  await env.BOOKINGS.delete(STRIKE_KEY(normalized));
}

// ---------------------------------------------------------------------
// PER-IP RATE-LIMIT EXEMPTION — the "🚦 Rate Limit" on/off admin
// control (see telegram-bot.js's sendRateLimitMenu). Deliberately
// narrower than the ADMIN_IPS / x-admin-secret bypass above: an
// exempted IP still goes through the blocklist, body-size guard, and
// attack-pattern checks in securityGate — it only skips step 4 (the
// per-route request-count cap). And it can only ever be turned on with
// a real phone number attached, so "who is this" is always answerable
// — never a bare IP an admin trusted on a whim.
// ---------------------------------------------------------------------

const RL_EXEMPT_KEY = (ip) => `sec:rlexempt:${ip}`;
const RL_EXEMPT_LIST_KEY = "sec:rlexempt:list"; // small index of IPs currently exempt — cheap to render in the admin menu without a KV list() scan

export async function isRateLimitExempt(env, ip) {
  const raw = await env.BOOKINGS.get(RL_EXEMPT_KEY(normalizeIp(ip)));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readExemptIndex(env) {
  const raw = await env.BOOKINGS.get(RL_EXEMPT_LIST_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// Turns the rate limit OFF for `ip`. `phone` (digits, with country
// code) is required — this is what makes the exemption a real,
// identifiable person rather than an anonymous carve-out, e.g. so the
// admin can call/WhatsApp them if that IP later starts misbehaving.
//
// Also lifts any EXISTING block/strikes on this IP (see adminUnblock
// above). Without this, exempting an IP that already tripped the
// auto-block (STRIKE_THRESHOLD reached from repeated rate-limit hits —
// e.g. testing bookings/ratings back-to-back) looked completely broken:
// the blocklist check (securityGate step 1) runs BEFORE the rate-limit-
// exemption check (step 4), so a still-blocked IP kept getting 403s no
// matter how the rate limit itself was configured. Turning this toggle
// ON is the admin vouching for a real person by name/phone — that
// should also mean "let them back in right now", not just "stop
// counting their future requests".
export async function setRateLimitExempt(env, ip, phone, note) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (!digits) throw new Error("A phone number is required to exempt an IP from rate limiting.");
  const normalized = normalizeIp(ip);
  const record = { ip: normalized, phone: digits, note: note ? String(note).slice(0, 200) : "", grantedAt: Date.now() };
  // No expirationTtl — an admin explicitly turned this on for a named
  // person; it should stay on until they explicitly turn it back off,
  // not silently expire and start throttling someone mid-trip.
  await env.BOOKINGS.put(RL_EXEMPT_KEY(normalized), JSON.stringify(record));
  const index = await readExemptIndex(env);
  if (!index.includes(normalized)) {
    index.push(normalized);
    await env.BOOKINGS.put(RL_EXEMPT_LIST_KEY, JSON.stringify(index));
  }
  await adminUnblock(env, normalized);
  return record;
}

// Turns the rate limit back ON for `ip` (removes the exemption).
export async function clearRateLimitExempt(env, ip) {
  const normalized = normalizeIp(ip);
  await env.BOOKINGS.delete(RL_EXEMPT_KEY(normalized));
  const index = await readExemptIndex(env);
  const next = index.filter((x) => x !== normalized);
  if (next.length !== index.length) {
    await env.BOOKINGS.put(RL_EXEMPT_LIST_KEY, JSON.stringify(next));
  }
}

// Every currently-exempt IP with its attached identifying details —
// for the admin menu list view.
export async function listRateLimitExemptions(env) {
  const index = await readExemptIndex(env);
  const records = await Promise.all(index.map((ip) => isRateLimitExempt(env, ip)));
  return records.filter(Boolean);
}
