/**
 * visitors.js — server-side "is this the same person" tracking, so a
 * single visitor triggers exactly ONE notification per real visit (not
 * one per page load), correctly labelled 🆕 New or 🔁 Returning, with a
 * running visit count per visitor and an optional admin-assigned name.
 *
 * IDENTITY: a visitor is identified by hashing (normalized IP + User
 * Agent) together. normalizeIp() is the same helper security.js already
 * uses for IP-based blocks/exemptions — it collapses a mobile visitor's
 * rotating IPv6 suffix down to one stable /64 prefix, so a phone
 * changing towers mid-session doesn't look like a new person.
 *
 * Why IP+UA, and not something else — see the pros/cons the admin asked
 * for:
 *   - A cookie / localStorage id alone is wiped the instant the visitor
 *     clears their browser data or opens a private window — at that
 *     point they'd look brand-new even though they're the same person.
 *     That fails the "remember them even after they clear cookies"
 *     requirement outright, so it can't be the ONLY signal.
 *   - IP alone is too coarse: everyone on one office/café/apartment
 *     building's shared connection collides into "one visitor", and one
 *     real person's IP already changes on its own (home wifi → mobile
 *     data), splitting them into several "different people" over time.
 *   - User-Agent alone is far too coarse: thousands of unrelated people
 *     run the exact same browser/OS build, so almost everyone collides.
 *   - IP + UA together is the practical middle ground used here: two
 *     people now have to share BOTH the same IP AND the exact same
 *     browser/OS string to be confused for one another — a small
 *     residual error (mostly identical devices on the same office wifi),
 *     not a common false match.
 *   - No signal is perfect without invasive device fingerprinting
 *     (canvas/font/audio fingerprinting etc.), which this project
 *     intentionally does not do. IP+UA is the standard "good enough,
 *     server-side, no invasive tracking" compromise. It slightly
 *     UNDER-counts distinct people behind heavy shared IPs (e.g. large
 *     office NATs), and can rarely OVER-split one person whose IP and
 *     browser both change between visits (new phone, reinstalled
 *     browser, switched networks) — both are the same trade-off any
 *     small site's "unique visitor" counter makes.
 *
 * KV layout (env.BOOKINGS — same KV namespace everything else here
 * already uses):
 *   visitor:<hash>       JSON { hash, name, firstSeen, lastSeen,
 *                        visitCount } — permanent, no TTL. Written with
 *                        `metadata` set to a small { name, visitCount,
 *                        lastSeen } summary so listVisitors() below can
 *                        page through every visitor via KV list() alone,
 *                        without a get() per row.
 *   visitsession:<hash>  sentinel value, TTL'd (VISIT_SESSION_TTL_SECONDS).
 *                        While this key exists, further /api/visit pings
 *                        from the same hash are the SAME open visit —
 *                        refresh, in-page click, redirect, background
 *                        request — and produce no notification. Once it
 *                        expires, the next ping is treated as a fresh
 *                        visit (notified again) but is NEVER re-counted
 *                        as a brand-new visitor — see recordVisit below.
 */
import { getClientIp, normalizeIp } from "./security.js";

// How long a visitor has to go quiet before coming back counts as a new
// *visit* (not a new visitor). 30 minutes is a common analytics default:
// long enough that normal browsing/reading/filling a form never
// triggers a second notification, short enough that "left and came back
// later" reliably does.
const VISIT_SESSION_TTL_SECONDS = 30 * 60;

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A short, stable id for this browser+connection — used as the KV key
// suffix and as the Telegram callback_data payload for naming a visitor
// (so it has to stay well under Telegram's 64-byte callback_data limit).
export async function hashVisitor(request) {
  const ip = normalizeIp(getClientIp(request));
  const ua = (request.headers.get("user-agent") || "unknown").slice(0, 300);
  const full = await sha256Hex(`${ip}|${ua}`);
  return full.slice(0, 20);
}

function visitorKey(hash) {
  return `visitor:${hash}`;
}
function sessionKey(hash) {
  return `visitsession:${hash}`;
}

export async function getVisitor(env, hash) {
  const raw = await env.BOOKINGS.get(visitorKey(hash));
  return raw ? JSON.parse(raw) : null;
}

async function saveVisitor(env, hash, record) {
  await env.BOOKINGS.put(visitorKey(hash), JSON.stringify(record), {
    metadata: { name: record.name || null, visitCount: record.visitCount, lastSeen: record.lastSeen },
  });
}

// Records one /api/visit ping and decides what the admin should see.
// Returns one of:
//   { status: "duplicate", hash }
//     — same open visit (refresh/click/redirect/background ping) —
//       caller must NOT send a notification or bump any counter.
//   { status: "new", hash, visitCount: 1, name: null }
//     — brand-new visitor, never seen before.
//   { status: "returning", hash, visitCount, name }
//     — a visitor we already have a record for, coming back after the
//       session window expired. Never reported as "new" again, no
//       matter how long ago they were first seen or how many times
//       they've cleared cookies since (identity is server-side, not
//       cookie-based).
export async function recordVisit(request, env) {
  const hash = await hashVisitor(request);
  const already = await env.BOOKINGS.get(sessionKey(hash));

  // Slide the "still the same visit" window forward on every ping,
  // including duplicates — continuous browsing (one page after
  // another, all well within the window) stays ONE visit throughout,
  // instead of the window quietly expiring mid-session.
  await env.BOOKINGS.put(sessionKey(hash), "1", { expirationTtl: VISIT_SESSION_TTL_SECONDS });
  if (already) return { status: "duplicate", hash };

  const now = Date.now();
  const existing = await getVisitor(env, hash);
  if (!existing) {
    const record = { hash, name: null, firstSeen: now, lastSeen: now, visitCount: 1 };
    await saveVisitor(env, hash, record);
    return { status: "new", hash, visitCount: 1, name: null };
  }

  existing.visitCount = (existing.visitCount || 1) + 1;
  existing.lastSeen = now;
  await saveVisitor(env, hash, existing);
  return { status: "returning", hash, visitCount: existing.visitCount, name: existing.name || null };
}

// Admin-assigned label — e.g. "John", "Spam bot", "Office IP" — shown on
// every future notification and in the Visitors list until changed.
export async function setVisitorName(env, hash, name) {
  const existing = await getVisitor(env, hash);
  if (!existing) return null;
  existing.name = name || null;
  await saveVisitor(env, hash, existing);
  return existing;
}

// Cheap listing for the admin bot's 👀 Visitors menu — reads KV
// metadata only (name/visitCount/lastSeen), never the full JSON body of
// every visitor. `limit` is a single KV list() page (max 1000).
export async function listVisitors(env, { limit = 200 } = {}) {
  const page = await env.BOOKINGS.list({ prefix: "visitor:", limit });
  const items = page.keys.map((k) => ({
    hash: k.name.slice("visitor:".length),
    name: (k.metadata && k.metadata.name) || null,
    visitCount: (k.metadata && k.metadata.visitCount) || 1,
    lastSeen: (k.metadata && k.metadata.lastSeen) || null,
  }));
  items.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  return items;
}
