/**
 * cms.js — the "website B admin dashboard" API.
 * -----------------------------------------------------------------------
 * Website B (the static Krem Chympe site) has no server. This file gives it
 * one: public read endpoints for the live site, and password-protected
 * endpoints for the /admin.html dashboard.
 *
 * STORAGE (nothing new to buy or create — no R2 needed):
 *   text / prices / gallery / slots / media list -> getDoc/saveDoc (KV cache +
 *       Telegram record, exactly like every other doc in this Worker)
 *   image + video FILES                           -> your Telegram admin chat (see
 *       tg-files.js). Max 20 MB per file (Telegram's download limit for bots).
 *
 * PUBLIC (CORS locked to SITE_B_ORIGIN, edge cached a few seconds)
 *   GET  /api/siteb/content          everything the site needs in ONE call
 *   GET  /api/siteb/version          tiny "has anything changed?" check
 *   GET  /api/siteb/media/<id>.<ext> an uploaded image/video (streamed from Telegram, 1-year cache)
 *
 * ADMIN (Authorization: Bearer <token>, CORS locked to SITE_B_ORIGIN)
 *   POST   /api/cms/login            { password }            -> token | { step:"code" }
 *   POST   /api/cms/verify           { challenge, code }     -> token
 *   POST   /api/cms/logout                                   -> signs out EVERY session
 *   GET    /api/cms/me
 *   GET    /api/cms/state            all overrides + media library + version
 *   PUT    /api/cms/content          { set:{path:value}, unset:[path] }
 *   PUT    /api/cms/prices           { prices: {...}|null }
 *   PUT    /api/cms/gallery          { gallery:[...]|null, explore:[...]|null }
 *   PUT    /api/cms/slots            { set:{ "videos/scene-1.mp4": "<mediaId>" }, unset:[path] }
 *   POST   /api/cms/media            multipart { file }      -> { media }
 *   DELETE /api/cms/media/<id>
 *   GET    /api/cms/feedback         every rating incl. hidden ones
 *   POST   /api/cms/feedback/<id>    { action: hide|show|pin|unpin }
 *   DELETE /api/cms/feedback/<id>
 *
 * Secrets (Cloudflare dashboard -> Worker -> Variables and Secrets -> type "Secret"):
 *   CMS_ADMIN_PASSWORD   12+ characters, only you know it
 *   CMS_TOKEN_SECRET     32+ random characters (signs login tokens)
 * Plain var (wrangler.toml):
 *   CMS_REQUIRE_CODE     "1" (default) = password + 6-digit code sent to your Telegram admin chat
 *                        "0"           = password only
 */

import { getDoc, saveDoc } from "./store.js";
import { withEdgeCache } from "./booking.js";
import { secureCompare, getClientIp, normalizeIp } from "./security.js";
import { tgSendMessage } from "./telegram.js";
import { deletePhotos } from "./ratings-photos.js";
import { tgUploadDocument, tgDeleteMessage, tgServeFile, TG_MAX_BYTES } from "./tg-files.js";

const SITE = "website-b";
const TOKEN_TTL_SECONDS = 12 * 60 * 60; // a login lasts 12 hours
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = TG_MAX_BYTES; // 20 MB: Telegram will not let a bot download more
const MAX_LIBRARY = 200;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const BLOCKED_TOP_LEVEL = new Set(["backend", "admin"]); // never editable from the web (backend = where bookings are sent)

export function isCmsPath(pathname) {
  return pathname.startsWith("/api/cms/") || /^\/api\/siteb\/(content|version|media\/)/.test(pathname);
}

// ---------------------------------------------------------------------
// CORS — locked to Website B's origin. The "x-cors-final" marker tells
// security.js's withSecurityHeaders NOT to overwrite these with the
// Worker-wide defaults (it strips the marker before the response leaves).
// ---------------------------------------------------------------------
function allowedOrigins(env) {
  return String(env.SITE_B_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
}
function originAllowed(env, request) {
  const list = allowedOrigins(env);
  if (!list.length) return false; // not configured -> refuse browsers rather than fall open
  if (list.includes("*")) return true;
  const origin = request.headers.get("Origin");
  return !origin || list.includes(origin); // no Origin = not a browser cross-site call
}
function corsFor(env, request) {
  const list = allowedOrigins(env);
  const origin = request.headers.get("Origin") || "";
  const h = {
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "authorization,content-type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
    "x-cors-final": "1",
  };
  if (list.includes("*")) h["Access-Control-Allow-Origin"] = "*";
  else if (origin && list.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
function reply(env, request, data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "Cache-Control": "no-store", ...corsFor(env, request), ...extra },
  });
}
export function cmsPreflight(request, env) {
  if (!originAllowed(env, request)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsFor(env, request) });
}

// ---------------------------------------------------------------------
// Tokens — HMAC-SHA256 signed "<payload>.<signature>", checked on every call.
// ---------------------------------------------------------------------
const enc = new TextEncoder();
function b64u(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uToStr(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}
function secretsOk(env) {
  return String(env.CMS_ADMIN_PASSWORD || "").length >= 12 && String(env.CMS_TOKEN_SECRET || "").length >= 32;
}
async function issueToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64u(enc.encode(JSON.stringify({ iat: now, exp: now + TOKEN_TTL_SECONDS, n: randHex(6) })));
  return { token: `${payload}.${await hmac(env.CMS_TOKEN_SECRET, payload)}`, expiresAt: (now + TOKEN_TTL_SECONDS) * 1000 };
}
async function checkToken(env, token) {
  try {
    const [payload, sig] = String(token || "").split(".");
    if (!payload || !sig) return false;
    if (!secureCompare(sig, await hmac(env.CMS_TOKEN_SECRET, payload))) return false;
    const p = JSON.parse(b64uToStr(payload));
    const now = Math.floor(Date.now() / 1000);
    if (!p.exp || p.exp < now) return false;
    const minIat = parseInt((await env.BOOKINGS.get("cms:minIat")) || "0", 10) || 0;
    return p.iat > minIat; // logout sets minIat to "now", which kills every token issued up to that second
  } catch {
    return false;
  }
}
async function requireAdmin(request, env) {
  if (!secretsOk(env)) return reply(env, request, { ok: false, error: "Dashboard is not configured on the server yet (secrets missing)." }, 503);
  if (!originAllowed(env, request)) return reply(env, request, { ok: false, error: "forbidden" }, 403);
  const m = /^Bearer (.+)$/.exec(request.headers.get("Authorization") || "");
  if (!m || !(await checkToken(env, m[1]))) return reply(env, request, { ok: false, error: "unauthorized" }, 401);
  return null;
}

function randHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randCode() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(a[0] % 1000000).padStart(6, "0");
}

// Login brute-force guard: 5 wrong guesses per IP per 15 minutes.
const FAIL_LIMIT = 5;
const FAIL_WINDOW = 15 * 60;
async function failCount(env, ip) {
  return parseInt((await env.BOOKINGS.get(`cms:fail:${normalizeIp(ip)}`)) || "0", 10) || 0;
}
async function addFail(env, ip) {
  const n = (await failCount(env, ip)) + 1;
  await env.BOOKINGS.put(`cms:fail:${normalizeIp(ip)}`, String(n), { expirationTtl: FAIL_WINDOW });
  return n;
}
async function clearFails(env, ip) {
  await env.BOOKINGS.delete(`cms:fail:${normalizeIp(ip)}`);
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function notify(env, ctx, text) {
  const chat = env.TELEGRAM_ADMIN_CHAT_ID;
  if (!chat || !env.TELEGRAM_BOT_TOKEN) return;
  const p = tgSendMessage(env, chat, text).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}

async function readJson(request) {
  try {
    const b = await request.json();
    return b && typeof b === "object" ? b : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------
async function handleLogin(request, env, ctx) {
  if (!secretsOk(env)) return reply(env, request, { ok: false, error: "Dashboard is not configured on the server yet (secrets missing)." }, 503);
  if (!originAllowed(env, request)) return reply(env, request, { ok: false, error: "forbidden" }, 403);
  const ip = getClientIp(request);
  if ((await failCount(env, ip)) >= FAIL_LIMIT) {
    return reply(env, request, { ok: false, error: "Too many wrong attempts. Try again in 15 minutes." }, 429, { "Retry-After": "900" });
  }
  const { password } = await readJson(request);
  if (!secureCompare(String(password || ""), env.CMS_ADMIN_PASSWORD)) {
    const n = await addFail(env, ip);
    if (n === FAIL_LIMIT) notify(env, ctx, `🚨 <b>Dashboard login locked</b>\n${FAIL_LIMIT} wrong passwords from <code>${esc(ip)}</code>`);
    return reply(env, request, { ok: false, error: "Wrong password." }, 401);
  }
  await clearFails(env, ip);

  if (String(env.CMS_REQUIRE_CODE ?? "1") === "0") {
    notify(env, ctx, `✅ <b>Website B dashboard login</b>\nIP <code>${esc(ip)}</code>`);
    return reply(env, request, { ok: true, ...(await issueToken(env)) });
  }
  if (!env.TELEGRAM_ADMIN_CHAT_ID || !env.TELEGRAM_BOT_TOKEN) {
    return reply(env, request, { ok: false, error: "Login code needs Telegram, which is not configured. Set CMS_REQUIRE_CODE to 0 to log in with the password only." }, 503);
  }
  const challenge = randHex(16);
  const code = randCode();
  await env.BOOKINGS.put(`cms:chal:${challenge}`, JSON.stringify({ code, tries: 0 }), { expirationTtl: 300 });
  const sent = await tgSendMessage(env, env.TELEGRAM_ADMIN_CHAT_ID, `🔐 <b>Website B dashboard code</b>\n<code>${code}</code>\nValid 5 minutes. Asked from IP <code>${esc(ip)}</code>. If this wasn't you, ignore it.`).catch(() => null);
  if (!sent || !sent.ok) {
    await env.BOOKINGS.delete(`cms:chal:${challenge}`);
    return reply(env, request, { ok: false, error: "Could not send the login code to Telegram. Try again." }, 502);
  }
  return reply(env, request, { ok: true, step: "code", challenge });
}

async function handleVerify(request, env, ctx) {
  if (!secretsOk(env)) return reply(env, request, { ok: false, error: "not configured" }, 503);
  if (!originAllowed(env, request)) return reply(env, request, { ok: false, error: "forbidden" }, 403);
  const ip = getClientIp(request);
  if ((await failCount(env, ip)) >= FAIL_LIMIT) return reply(env, request, { ok: false, error: "Too many wrong attempts. Try again in 15 minutes." }, 429);
  const { challenge, code } = await readJson(request);
  if (!/^[a-f0-9]{32}$/.test(String(challenge || ""))) return reply(env, request, { ok: false, error: "Start again." }, 400);
  const key = `cms:chal:${challenge}`;
  const raw = await env.BOOKINGS.get(key);
  if (!raw) return reply(env, request, { ok: false, error: "Code expired. Start again." }, 401);
  const rec = JSON.parse(raw);
  if (!secureCompare(String(code || "").trim(), rec.code)) {
    rec.tries = (rec.tries || 0) + 1;
    if (rec.tries >= 5) await env.BOOKINGS.delete(key);
    else await env.BOOKINGS.put(key, JSON.stringify(rec), { expirationTtl: 300 });
    await addFail(env, ip);
    return reply(env, request, { ok: false, error: "Wrong code." }, 401);
  }
  await env.BOOKINGS.delete(key); // one use only
  await clearFails(env, ip);
  notify(env, ctx, `✅ <b>Website B dashboard login</b>\nIP <code>${esc(ip)}</code>`);
  return reply(env, request, { ok: true, ...(await issueToken(env)) });
}

// ---------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------
const cleanStr = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);
const BAD_SCHEME = /^\s*(javascript|data|vbscript):/i;
const MEDIA_REF = /^media:([a-f0-9]{12})$/;
const KEY_SEG = /^[A-Za-z0-9_]{1,40}$/;

function validPath(path) {
  if (typeof path !== "string" || path.length > 120) return false;
  const parts = path.split(".");
  if (parts.length < 2 || parts.length > 7) return false; // a leaf always sits inside a section
  if (BLOCKED_TOP_LEVEL.has(parts[0])) return false;
  return parts.every((p) => KEY_SEG.test(p) && !FORBIDDEN_SEGMENTS.has(p));
}

// A text value is: string | number | boolean | array | flat-ish object of those (<= 3 levels deep).
function cleanValue(v, depth = 0) {
  if (typeof v === "string") {
    if (BAD_SCHEME.test(v)) throw new Error("That value isn't allowed.");
    return cleanStr(v, 4000);
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "boolean") return v;
  if (depth >= 3) throw new Error("Value is nested too deeply.");
  if (Array.isArray(v)) {
    if (v.length > 80) throw new Error("A list can hold at most 80 items.");
    return v.map((x) => cleanValue(x, depth + 1));
  }
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length > 30) throw new Error("Too many fields.");
    const out = {};
    for (const k of keys) {
      if (!KEY_SEG.test(k) || FORBIDDEN_SEGMENTS.has(k)) throw new Error("Bad field name.");
      out[k] = cleanValue(v[k], depth + 1);
    }
    return out;
  }
  throw new Error("Unsupported value.");
}

function cleanPrices(v) {
  const walk = (x, depth) => {
    if (depth > 7) throw new Error("Prices are nested too deeply.");
    if (x === null || typeof x === "boolean") return x;
    if (typeof x === "number") {
      if (!Number.isFinite(x) || x < 0 || x > 10000000) throw new Error("A price must be between 0 and 10,000,000.");
      return x;
    }
    if (typeof x === "string") {
      if (BAD_SCHEME.test(x)) throw new Error("That value isn't allowed.");
      return cleanStr(x, 200);
    }
    if (Array.isArray(x)) {
      if (x.length > 60) throw new Error("Too many items in a price list.");
      return x.map((i) => walk(i, depth + 1));
    }
    if (typeof x === "object") {
      const keys = Object.keys(x).filter((k) => k !== "_README");
      if (keys.length > 40) throw new Error("Too many price fields.");
      const out = {};
      for (const k of keys) {
        if (!/^[A-Za-z0-9_\-.]{1,40}$/.test(k) || FORBIDDEN_SEGMENTS.has(k)) throw new Error("Bad price field name.");
        out[k] = walk(x[k], depth + 1);
      }
      return out;
    }
    throw new Error("Unsupported price value.");
  };
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Prices must be an object.");
  const out = walk(v, 0);
  if (typeof out.minAdvance !== "number" || !out.packages || typeof out.packages !== "object") throw new Error("Prices must keep minAdvance and packages.");
  if (JSON.stringify(out).length > 40000) throw new Error("Prices are too large.");
  return out;
}

const REL_ASSET = /^(images|videos)\/[A-Za-z0-9_\-.]{1,100}$/;
function relAssetOk(p) {
  return REL_ASSET.test(p) && !p.includes("..");
}

function cleanGalleryList(list, kind, lib) {
  if (list === null) return null;
  if (!Array.isArray(list) || list.length > 40) throw new Error("A gallery can hold at most 40 items.");
  const byId = new Map(lib.map((m) => [m.id, m]));
  return list.map((it, i) => {
    const n = i + 1;
    if (!it || typeof it !== "object") throw new Error(`Item ${n} is invalid.`);
    const out = {
      name: cleanStr(it.name, 60),
      sub: cleanStr(it.sub, 60),
      desc: cleanStr(it.desc, 1000),
      pos: /^\d{1,3}% \d{1,3}%$/.test(String(it.pos || "")) ? it.pos : "50% 50%",
    };
    if (!out.name) throw new Error(`Item ${n} needs a name.`);
    const refCheck = (ref, wantType, label) => {
      const m = MEDIA_REF.exec(ref);
      if (!m) return false;
      const media = byId.get(m[1]);
      if (!media) throw new Error(`Item ${n}: that ${label} was deleted from the library.`);
      if (media.type !== wantType) throw new Error(`Item ${n}: ${label} must be ${wantType === "image" ? "a picture" : "a video"}.`);
      return true;
    };
    const image = cleanStr(it.image, 120);
    if (image) {
      if (!refCheck(image, "image", "picture") && !relAssetOk(image)) throw new Error(`Item ${n}: picture is not valid.`);
      out.image = image;
    }
    if (kind === "explore") {
      const video = cleanStr(it.video, 120);
      if (video) {
        if (MEDIA_REF.test(video)) refCheck(video, "video", "video");
        else if (!/^[A-Za-z0-9_-]{1,40}$/.test(video)) throw new Error(`Item ${n}: video is not valid.`);
        out.video = video;
      }
      if (!out.video && !out.image) throw new Error(`Item ${n} needs a picture or a video.`);
      if (out.video && MEDIA_REF.test(out.video) && !out.image) throw new Error(`Item ${n}: add a round picture for the video.`);
    } else if (!out.image) throw new Error(`Item ${n} needs a picture.`);
    return out;
  });
}

const SLOT_PATH = /^(images|videos)\/[A-Za-z0-9_\-.]{1,80}$/;
const IMG_EXT = /\.(jpe?g|png|webp)$/i;
const VID_EXT = /\.(mp4|webm)$/i;

// ---------------------------------------------------------------------
// Doc access
// ---------------------------------------------------------------------
const D = {
  content: `content:${SITE}`,
  prices: `prices:${SITE}`,
  gallery: `gallery:${SITE}`,
  slots: `slots:${SITE}`,
  media: `media:${SITE}`,
  ratings: `ratings:${SITE}`,
};
async function saveSafe(env, key, value, log) {
  try {
    await saveDoc(env, key, value, { logChange: `🌐 Web dashboard: ${log}` });
  } catch (e) {
    // KV (the live copy) is written first inside saveDoc, so a Telegram hiccup must not fail the edit.
  }
}
async function bumpVersion(env) {
  const v = String(Date.now());
  await env.BOOKINGS.put("cms:version", v);
  return v;
}
async function getVersion(env) {
  return (await env.BOOKINGS.get("cms:version")) || "0";
}
const mediaUrl = (origin, m) => `${origin}/api/siteb/media/${m.id}.${m.ext}`;

function resolveRefs(value, urlOf) {
  if (typeof value === "string") {
    const m = MEDIA_REF.exec(value);
    if (!m) return value;
    return urlOf(m[1]); // undefined when the file no longer exists
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, urlOf));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = resolveRefs(value[k], urlOf);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------
// Public endpoints
// ---------------------------------------------------------------------
async function handlePublicContent(request, env, ctx) {
  return withEdgeCache(request, ctx, 5, async () => {
    const origin = new URL(request.url).origin;
    const [version, content, prices, gal, slots, lib] = await Promise.all([
      getVersion(env),
      getDoc(env, D.content, {}),
      getDoc(env, D.prices, null),
      getDoc(env, D.gallery, {}),
      getDoc(env, D.slots, {}),
      getDoc(env, D.media, []),
    ]);
    const byId = new Map((Array.isArray(lib) ? lib : []).map((m) => [m.id, m]));
    const urlOf = (id) => (byId.get(id) ? mediaUrl(origin, byId.get(id)) : undefined);

    const outContent = {};
    for (const k of Object.keys(content || {})) {
      const v = resolveRefs(content[k], urlOf);
      if (v !== undefined) outContent[k] = v;
    }
    const outSlots = {};
    for (const p of Object.keys(slots || {})) {
      const u = urlOf(slots[p]);
      if (u) outSlots[p] = u;
    }
    const shape = (list) =>
      Array.isArray(list)
        ? list.map((it) => {
            const o = { ...it };
            if (typeof o.image === "string" && MEDIA_REF.test(o.image)) o.image = urlOf(o.image.slice(6)) || "";
            if (typeof o.video === "string" && MEDIA_REF.test(o.video)) {
              o.videoUrl = urlOf(o.video.slice(6)) || "";
              delete o.video;
            }
            return o;
          })
        : null;
    return reply(env, request, {
      ok: true,
      version,
      content: outContent,
      prices: prices && prices.packages ? prices : null,
      gallery: shape(gal && gal.gallery),
      explore: shape(gal && gal.explore),
      slots: outSlots,
    }, 200, { "Cache-Control": "public, max-age=5" });
  });
}

async function handlePublicVersion(request, env, ctx) {
  return withEdgeCache(request, ctx, 5, async () =>
    reply(env, request, { ok: true, version: await getVersion(env) }, 200, { "Cache-Control": "public, max-age=5" })
  );
}

async function serveMedia(request, env, ctx, file) {
  const m = /^([a-f0-9]{12})\.(jpg|png|webp|mp4|webm)$/.exec(file);
  if (!m) return new Response("Not found", { status: 404 });
  const run = async () => {
    const lib = await getDoc(env, D.media, []);
    const item = (Array.isArray(lib) ? lib : []).find((x) => x.id === m[1] && x.ext === m[2]);
    if (!item || !item.fid) return new Response("Not found", { status: 404 });
    return tgServeFile(request, env, item.fid, item.mime, corsFor(env, request));
  };
  // Pictures are small: cache at the edge so Telegram is only asked once. Videos stream
  // (range requests) straight through and are cached by the visitor's browser instead.
  if (m[2] === "mp4" || m[2] === "webm" || request.headers.has("range") || request.method === "HEAD") return run();
  return withEdgeCache(request, ctx, 86400, run);
}

// ---------------------------------------------------------------------
// Admin endpoints
// ---------------------------------------------------------------------
async function handleState(request, env) {
  const origin = new URL(request.url).origin;
  const [version, content, prices, gal, slots, lib] = await Promise.all([
    getVersion(env), getDoc(env, D.content, {}), getDoc(env, D.prices, null), getDoc(env, D.gallery, {}), getDoc(env, D.slots, {}), getDoc(env, D.media, []),
  ]);
  const media = (Array.isArray(lib) ? lib : []).map(({ fid, mid, ...m }) => ({ ...m, url: mediaUrl(origin, m) }));
  return reply(env, request, {
    ok: true, version, content: content || {}, prices: prices && prices.packages ? prices : null,
    gallery: gal.gallery || null, explore: gal.explore || null, slots: slots || {}, media,
  });
}

async function handlePutContent(request, env) {
  const body = await readJson(request);
  const set = body.set && typeof body.set === "object" ? body.set : {};
  const unset = Array.isArray(body.unset) ? body.unset : [];
  const keys = Object.keys(set);
  if (keys.length + unset.length > 400) return reply(env, request, { ok: false, error: "Too many changes at once." }, 400);
  const lib = await getDoc(env, D.media, []);
  const ids = new Set(lib.map((m) => m.id));
  const doc = await getDoc(env, D.content, {});
  for (const p of keys) {
    if (!validPath(p)) return reply(env, request, { ok: false, error: `That text can't be edited: ${p}` }, 400);
    let v;
    try { v = cleanValue(set[p]); } catch (e) { return reply(env, request, { ok: false, error: `${p}: ${e.message}` }, 400); }
    const refs = JSON.stringify(v).match(/media:[a-f0-9]{12}/g) || [];
    if (refs.some((r) => !ids.has(r.slice(6)))) return reply(env, request, { ok: false, error: `${p}: that file is not in the library.` }, 400);
    doc[p] = v;
  }
  for (const p of unset) {
    if (typeof p === "string" && Object.prototype.hasOwnProperty.call(doc, p)) delete doc[p];
  }
  if (JSON.stringify(doc).length > 250000) return reply(env, request, { ok: false, error: "Too much edited text." }, 400);
  await saveSafe(env, D.content, doc, `${keys.length} text(s) saved, ${unset.length} reset${keys.length ? " — " + keys.slice(0, 6).join(", ") + (keys.length > 6 ? "…" : "") : ""}`);
  return reply(env, request, { ok: true, version: await bumpVersion(env), content: doc });
}

async function handlePutPrices(request, env) {
  const body = await readJson(request);
  let prices = null;
  if (body.prices !== null) {
    try { prices = cleanPrices(body.prices); } catch (e) { return reply(env, request, { ok: false, error: e.message }, 400); }
  }
  await saveSafe(env, D.prices, prices, prices ? "prices saved" : "prices reset to the original file");
  return reply(env, request, { ok: true, version: await bumpVersion(env), prices });
}

async function handlePutGallery(request, env) {
  const body = await readJson(request);
  const lib = await getDoc(env, D.media, []);
  const doc = await getDoc(env, D.gallery, {});
  try {
    if ("gallery" in body) doc.gallery = cleanGalleryList(body.gallery, "gallery", lib);
    if ("explore" in body) doc.explore = cleanGalleryList(body.explore, "explore", lib);
  } catch (e) {
    return reply(env, request, { ok: false, error: e.message }, 400);
  }
  if (doc.gallery === null) delete doc.gallery;
  if (doc.explore === null) delete doc.explore;
  await saveSafe(env, D.gallery, doc, `gallery saved (${(doc.gallery || []).length} photos, ${(doc.explore || []).length} hero scenes)`);
  return reply(env, request, { ok: true, version: await bumpVersion(env), gallery: doc.gallery || null, explore: doc.explore || null });
}

async function handlePutSlots(request, env) {
  const body = await readJson(request);
  const set = body.set && typeof body.set === "object" ? body.set : {};
  const unset = Array.isArray(body.unset) ? body.unset : [];
  const lib = await getDoc(env, D.media, []);
  const byId = new Map(lib.map((m) => [m.id, m]));
  const slots = await getDoc(env, D.slots, {});
  for (const p of Object.keys(set)) {
    if (!SLOT_PATH.test(p) || p.includes("..")) return reply(env, request, { ok: false, error: `Not a site file: ${p}` }, 400);
    const media = byId.get(String(set[p]));
    if (!media) return reply(env, request, { ok: false, error: `${p}: that file is not in the library.` }, 400);
    if (IMG_EXT.test(p) && media.type !== "image") return reply(env, request, { ok: false, error: `${p} needs a picture, not a video.` }, 400);
    if (VID_EXT.test(p) && media.type !== "video") return reply(env, request, { ok: false, error: `${p} needs a video, not a picture.` }, 400);
    if (!IMG_EXT.test(p) && !VID_EXT.test(p)) return reply(env, request, { ok: false, error: `${p}: unsupported file type.` }, 400);
    slots[p] = media.id;
  }
  for (const p of unset) if (typeof p === "string") delete slots[p];
  if (Object.keys(slots).length > 100) return reply(env, request, { ok: false, error: "Too many replaced files." }, 400);
  await saveSafe(env, D.slots, slots, `replaced files: ${Object.keys(set).join(", ") || "—"}; reverted: ${unset.join(", ") || "—"}`);
  return reply(env, request, { ok: true, version: await bumpVersion(env), slots });
}

// ---- media upload ----
function sniff(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: "image", mime: "image/jpeg", ext: "jpg" };
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { type: "image", mime: "image/png", ext: "png" };
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return { type: "image", mime: "image/webp", ext: "webp" };
  if (b.length >= 12 && String.fromCharCode(...b.slice(4, 8)) === "ftyp") return { type: "video", mime: "video/mp4", ext: "mp4" };
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { type: "video", mime: "video/webm", ext: "webm" };
  return null;
}

async function handleUpload(request, env) {
  if (!(request.headers.get("content-type") || "").includes("multipart/form-data")) return reply(env, request, { ok: false, error: "Send the file as multipart/form-data." }, 400);
  let form;
  try { form = await request.formData(); } catch { return reply(env, request, { ok: false, error: "Upload could not be read." }, 400); }
  const file = form.get("file");
  if (!file || typeof file === "string") return reply(env, request, { ok: false, error: "No file received." }, 400);
  if (!file.size) return reply(env, request, { ok: false, error: "That file is empty." }, 400);
  if (file.size > MAX_VIDEO_BYTES) return reply(env, request, { ok: false, error: "File is too large (up to 20 MB; pictures up to 8 MB)." }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(bytes); // trust the real bytes, never the browser's claimed type
  if (!kind) return reply(env, request, { ok: false, error: "Only JPG, PNG, WebP pictures and MP4/WebM videos are allowed." }, 400);
  if (kind.type === "image" && file.size > MAX_IMAGE_BYTES) return reply(env, request, { ok: false, error: "Pictures can be up to 8 MB." }, 413);

  const lib = await getDoc(env, D.media, []);
  const list = Array.isArray(lib) ? lib : [];
  if (list.length >= MAX_LIBRARY) return reply(env, request, { ok: false, error: "Media library is full. Delete unused files first." }, 400);
  const id = randHex(6);
  let stored;
  try {
    stored = await tgUploadDocument(env, bytes, kind.mime, `${id}.${kind.ext}`, `🖼 site upload ${id}`);
  } catch (e) {
    return reply(env, request, { ok: false, error: e.message }, 502);
  }
  const media = { id, name: cleanStr(file.name || "upload", 80), type: kind.type, mime: kind.mime, ext: kind.ext, size: file.size, ts: Date.now(), fid: stored.fileId, mid: stored.messageId };
  list.unshift(media);
  await saveSafe(env, D.media, list, `uploaded ${media.type} "${media.name}" (${Math.round(file.size / 1024)} KB)`);
  await bumpVersion(env);
  const { fid, mid, ...pub } = media;
  return reply(env, request, { ok: true, media: { ...pub, url: mediaUrl(new URL(request.url).origin, media) } });
}

function usageOf(id, { content, gal, slots }) {
  const ref = `media:${id}`;
  const used = [];
  for (const [p, v] of Object.entries(content || {})) if (JSON.stringify(v).includes(ref)) used.push(`text ${p}`);
  for (const kind of ["gallery", "explore"]) (gal[kind] || []).forEach((it, i) => { if (it.image === ref || it.video === ref) used.push(`${kind} item ${i + 1}`); });
  for (const [p, mid] of Object.entries(slots || {})) if (mid === id) used.push(`replaces ${p}`);
  return used;
}

async function handleDeleteMedia(request, env, id) {
  if (!/^[a-f0-9]{12}$/.test(id)) return reply(env, request, { ok: false, error: "bad id" }, 400);
  const [lib, content, gal, slots] = await Promise.all([getDoc(env, D.media, []), getDoc(env, D.content, {}), getDoc(env, D.gallery, {}), getDoc(env, D.slots, {})]);
  const item = lib.find((m) => m.id === id);
  if (!item) return reply(env, request, { ok: false, error: "Not found." }, 404);
  const used = usageOf(id, { content, gal, slots });
  if (used.length) return reply(env, request, { ok: false, error: `Still in use: ${used.join(", ")}. Change those first.`, used }, 409);
  await tgDeleteMessage(env, item.mid); // removes the stored copy from the admin chat too
  await saveSafe(env, D.media, lib.filter((m) => m.id !== id), `deleted ${item.type} "${item.name}"`);
  await bumpVersion(env);
  return reply(env, request, { ok: true });
}

// ---- feedback (the ratings doc the site + Telegram bot already share) ----
async function handleFeedbackList(request, env) {
  const list = await getDoc(env, D.ratings, []);
  const origin = new URL(request.url).origin;
  const items = (Array.isArray(list) ? list : []).map((r) => ({
    ...r,
    photoUrls: (r.photos || []).filter((k) => /^reviews\/[A-Za-z0-9_-]{1,64}\/[1-3]\.webp$/.test(k)).map((k) => `${origin}/api/rating-photo/${k}`),
  }));
  return reply(env, request, { ok: true, feedback: items });
}

async function handleFeedbackAction(request, env, id, method) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return reply(env, request, { ok: false, error: "bad id" }, 400);
  const list = await getDoc(env, D.ratings, []);
  const arr = Array.isArray(list) ? list : [];
  const idx = arr.findIndex((r) => r && r.id === id);
  if (idx < 0) return reply(env, request, { ok: false, error: "Not found." }, 404);
  if (method === "DELETE") {
    const [gone] = arr.splice(idx, 1);
    await deletePhotos(env, gone.photos || []).catch(() => {});
    await saveSafe(env, D.ratings, arr, `deleted feedback from ${gone.name || "visitor"}`);
  } else {
    const { action } = await readJson(request);
    const e = arr[idx];
    if (action === "hide") e.hidden = true;
    else if (action === "show") delete e.hidden;
    else if (action === "pin") e.pinned = true;
    else if (action === "unpin") e.pinned = false;
    else return reply(env, request, { ok: false, error: "Unknown action." }, 400);
    await saveSafe(env, D.ratings, arr, `${action} feedback from ${e.name || "visitor"}`);
  }
  return reply(env, request, { ok: true });
}

// ---------------------------------------------------------------------
// Router — returns a Response, or null when the path isn't ours.
// ---------------------------------------------------------------------
export async function handleCms(request, env, ctx, url) {
  const p = url.pathname;
  const method = request.method;

  // public
  if (method === "GET" && p === "/api/siteb/content") return handlePublicContent(request, env, ctx);
  if (method === "GET" && p === "/api/siteb/version") return handlePublicVersion(request, env, ctx);
  if ((method === "GET" || method === "HEAD") && p.startsWith("/api/siteb/media/")) return serveMedia(request, env, ctx, p.slice("/api/siteb/media/".length));

  if (!p.startsWith("/api/cms/")) return null;

  // login steps need no token
  if (method === "POST" && p === "/api/cms/login") return handleLogin(request, env, ctx);
  if (method === "POST" && p === "/api/cms/verify") return handleVerify(request, env, ctx);

  // everything below needs a valid token
  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  if (method === "GET" && p === "/api/cms/me") return reply(env, request, { ok: true });
  if (method === "POST" && p === "/api/cms/logout") {
    await env.BOOKINGS.put("cms:minIat", String(Math.floor(Date.now() / 1000)));
    return reply(env, request, { ok: true });
  }
  if (method === "GET" && p === "/api/cms/state") return handleState(request, env);
  if (method === "PUT" && p === "/api/cms/content") return handlePutContent(request, env);
  if (method === "PUT" && p === "/api/cms/prices") return handlePutPrices(request, env);
  if (method === "PUT" && p === "/api/cms/gallery") return handlePutGallery(request, env);
  if (method === "PUT" && p === "/api/cms/slots") return handlePutSlots(request, env);
  if (method === "POST" && p === "/api/cms/media") return handleUpload(request, env);
  if (method === "DELETE" && p.startsWith("/api/cms/media/")) return handleDeleteMedia(request, env, p.slice("/api/cms/media/".length));
  if (method === "GET" && p === "/api/cms/feedback") return handleFeedbackList(request, env);
  if ((method === "POST" || method === "DELETE") && p.startsWith("/api/cms/feedback/")) return handleFeedbackAction(request, env, p.slice("/api/cms/feedback/".length), method);

  return reply(env, request, { ok: false, error: "not found" }, 404);
}
