/**
 * content-api.js — the read endpoints the live website calls, plus the
 * /media proxy that serves admin-uploaded photos straight out of
 * Telegram (no separate image host, no bytes duplicated anywhere).
 */

import { SCHEMA_DEFAULTS } from "./content-schema.js";
import { isValidSite, getDoc, saveDoc, deepMerge } from "./store.js";
import { calculatePrice, DEFAULT_DISCOUNTS } from "./pricing.js";
import { tgResolveFileUrl } from "./telegram.js";
import { json, corsHeaders, withEdgeCache } from "./booking.js";
import { secureCompare } from "./security.js";

// Public GET content endpoints are cached at the edge for this long.
// Short enough that a Telegram admin edit is live for every visitor
// well within half a minute; long enough to absorb almost all repeat
// traffic without touching KV.
const CONTENT_CACHE_TTL = 30;

export async function handleGetContent(request, url, env, ctx) {
  const site = url.searchParams.get("site");
  if (!isValidSite(site)) return json({ ok: false, error: "bad site" }, env, 400);
  return withEdgeCache(request, ctx, CONTENT_CACHE_TTL, async () => {
    // Only the admin's own edits go over the wire here — NOT merged with
    // SCHEMA_DEFAULTS first. live-content.js already has the full default
    // content locally (baked into config.js, loaded before this request
    // even fires) and deep-merges this response on top of it itself; the
    // only consumer of this endpoint is that visitor-facing merge (the
    // Telegram admin bot reads SCHEMA_DEFAULTS directly from this same
    // module, not over HTTP). Sending the merged object too was pure
    // duplication: every page load was downloading the ~20-30KB static
    // schema a second time, for content already sitting in config.js.
    const override = await getDoc(env, `content:${site}`, {});
    return json({ ok: true, content: override }, env);
  });
}

export async function handleGetPrices(request, url, env, ctx) {
  const site = url.searchParams.get("site");
  if (!isValidSite(site)) return json({ ok: false, error: "bad site" }, env, 400);
  return withEdgeCache(request, ctx, CONTENT_CACHE_TTL, async () => {
    // Same reasoning as handleGetContent above — thin override only.
    const override = await getDoc(env, `prices:${site}`, {});
    return json({ ok: true, prices: override }, env);
  });
}

// Only returns keys the admin has actually changed via the bot — the
// site keeps using its own local static image for everything else.
//
// Defensive guard: an older version of the admin bot could accidentally
// save the *entire* default image map (filenames like "hero-bg-2.jpg",
// not real Telegram file_ids) into this doc instead of just the one
// photo that was actually changed (see saveLeaf in telegram-bot.js).
// That "poisoned" every image on the site, because /media/:site/:key
// would then try to resolve a plain filename as if it were a Telegram
// file_id and always 404. We now skip any key whose stored value is
// still just the untouched default filename — only genuine overrides
// ever get turned into a /media link. This makes any already-poisoned
// KV doc self-heal on the very next page load, no manual reset needed.
export async function handleGetImages(request, url, env, ctx) {
  const site = url.searchParams.get("site");
  if (!isValidSite(site)) return json({ ok: false, error: "bad site" }, env, 400);
  return withEdgeCache(request, ctx, CONTENT_CACHE_TTL, async () => {
    const override = await getDoc(env, `images:${site}`, {});
    const defaults = SCHEMA_DEFAULTS[site]?.KC_IMAGES || {};
    const urls = {};
    for (const key of Object.keys(override)) {
      const value = override[key];
      if (!value || typeof value !== "string" || value === defaults[key]) continue;
      urls[key] = `/media/${site}/${key}`;
    }
    return json({ ok: true, images: urls }, env);
  });
}

export async function handleGetHighlights(request, url, env, ctx) {
  const site = url.searchParams.get("site");
  if (!isValidSite(site)) return json({ ok: false, error: "bad site" }, env, 400);
  return withEdgeCache(request, ctx, CONTENT_CACHE_TTL, async () => {
    const items = await getDoc(env, `highlights:${site}`, []);
    return json({ ok: true, highlights: (items || []).filter((h) => h.active !== false) }, env);
  });
}

export async function handleGetDiscounts(request, env, ctx) {
  return withEdgeCache(request, ctx, CONTENT_CACHE_TTL, async () => {
    const override = await getDoc(env, "discounts:global", {});
    return json({ ok: true, discounts: deepMerge(DEFAULT_DISCOUNTS, override) }, env);
  });
}

// POST /api/admin/reset-images  { site, keys: ["logo", "expeditionPackageCard"] }
// Header: x-admin-secret: <ADMIN_API_SECRET>
//
// Same effect as tapping "↩️ Reset this one to default" on the Telegram
// admin bot, but callable over HTTP — for fixing a stale/broken photo
// override without going through the bot's menus. Clears only the
// named keys from the images:<site> doc (leaving every other
// admin-uploaded photo untouched) so the site falls back to whatever
// is currently the static default (config.js / SCHEMA_DEFAULTS) for
// those keys.
export async function handleAdminResetImages(request, env) {
  if (!env.ADMIN_API_SECRET) {
    return json({ ok: false, error: "ADMIN_API_SECRET is not configured on this Worker" }, env, 500);
  }
  const secret = request.headers.get("x-admin-secret") || "";
  if (!secureCompare(secret, env.ADMIN_API_SECRET)) {
    return json({ ok: false, error: "forbidden" }, env, 403);
  }

  const { site, keys } = await request.json();
  if (!isValidSite(site) || !Array.isArray(keys) || !keys.length) {
    return json({ ok: false, error: "site and keys[] are required" }, env, 400);
  }

  const docKey = `images:${site}`;
  const override = await getDoc(env, docKey, {});
  const removed = [];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(override, key)) {
      delete override[key];
      removed.push(key);
    }
  }
  await saveDoc(env, docKey, override, {
    logChange: removed.length
      ? `Reset photo(s) to default via admin API: ${removed.join(", ")}`
      : "Admin API reset requested — nothing was overridden",
  });

  return json({ ok: true, removed }, env);
}

export async function handleCalculatePrice(request, env) {
  const body = await request.json();
  const { site, packageKey, unitPrice, persons, addons, dateISO, code } = body || {};
  if (!isValidSite(site) || typeof unitPrice !== "number") {
    return json({ ok: false, error: "site and unitPrice are required" }, env, 400);
  }
  const override = await getDoc(env, "discounts:global", {});
  const discounts = deepMerge(DEFAULT_DISCOUNTS, override);
  const result = calculatePrice(discounts, {
    site,
    packageKey: packageKey || "default",
    unitPrice,
    persons: persons || 1,
    addons: addons || [],
    dateISO,
    code,
  });
  return json({ ok: true, ...result }, env);
}

// GET /media/<site>/<key> — resolves the stored Telegram file_id to a
// fresh CDN link and streams the bytes straight through. Nothing is
// cached on our side beyond normal HTTP caching, by design — Telegram
// is the only place the image bytes live.
export async function handleMedia(request, url, env, ctx) {
  const parts = url.pathname.split("/").filter(Boolean); // ["media", site, key]
  const [, site, key] = parts;
  if (!isValidSite(site) || !key) return new Response("not found", { status: 404 });

  // Every uncached hit here costs TWO live Telegram round-trips (resolve
  // file_id -> CDN url, then fetch the bytes) before a single byte
  // reaches the visitor. Admin-uploaded photos change rarely, so this is
  // a good edge-cache candidate — bumped from 5 min to 1 hour, backed by
  // the actual Cache API (not just a header) so repeat visits worldwide
  // skip Telegram entirely during that window.
  return withEdgeCache(request, ctx, 3600, async () => {
    const override = await getDoc(env, `images:${site}`, {});
    const fileId = override[key];
    const defaults = SCHEMA_DEFAULTS[site]?.KC_IMAGES || {};
    // Same guard as handleGetImages: never try to resolve a plain default
    // filename (not a real Telegram file_id) through the Telegram API.
    if (!fileId || typeof fileId !== "string" || fileId === defaults[key]) {
      return new Response("not found", { status: 404 });
    }

    const fileUrl = await tgResolveFileUrl(env, fileId);
    if (!fileUrl) return new Response("not found", { status: 404 });

    const upstream = await fetch(fileUrl);
    if (!upstream.ok) return new Response("not found", { status: 404 });

    const headers = new Headers(upstream.headers);
    headers.set("Access-Control-Allow-Origin", corsHeaders(env)["Access-Control-Allow-Origin"]);
    return new Response(upstream.body, { status: 200, headers });
  });
}

// GET /media-video/<site>/<key> — same trick as /media above, but for
// admin-uploaded background videos (see telegram-bot.js's video upload
// flow, which writes into `videos:${site}` and points
// background.global.videoUrl at this route). key: "global" for the
// site-wide video, or a page/section key for a specific override.
export async function handleVideoMedia(request, url, env) {
  const parts = url.pathname.split("/").filter(Boolean); // ["media-video", site, key]
  const [, site, key] = parts;
  if (!isValidSite(site) || !key) return new Response("not found", { status: 404 });

  const doc = await getDoc(env, `videos:${site}`, {});
  const fileId = doc[key];
  if (!fileId || typeof fileId !== "string") return new Response("not found", { status: 404 });

  const fileUrl = await tgResolveFileUrl(env, fileId);
  if (!fileUrl) return new Response("not found", { status: 404 });

  // Forward the browser's Range header (video players — especially
  // Safari/iOS — always send one, even on first load) so Telegram's CDN
  // can respond with 206 Partial Content instead of sending the whole
  // file on every request.
  const range = request && request.headers.get("range");
  const upstream = await fetch(fileUrl, range ? { headers: { Range: range } } : undefined);
  if (!upstream.ok && upstream.status !== 206) return new Response("not found", { status: 404 });

  const headers = new Headers(upstream.headers);
  headers.set("Cache-Control", "public, max-age=3600");
  headers.set("Access-Control-Allow-Origin", corsHeaders(env)["Access-Control-Allow-Origin"]);
  return new Response(upstream.body, { status: upstream.status, headers });
}
