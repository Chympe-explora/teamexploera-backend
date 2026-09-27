/**
 * stats.js — a single pinned, permanently-updating message in the
 * TELEGRAM ADMIN CHAT showing live visitor counts and a confirmed-
 * booking count. Edited in place (never a new message) so it genuinely
 * "stays on screen" — pinning keeps it at the top of the chat no matter
 * how far the rest of the conversation scrolls.
 *
 * - New visitors: bumped once per DISTINCT visitor, the first time
 *   they're ever seen (see visitors.js#recordVisit, status "new").
 * - Returning visits: bumped every time an already-known visitor comes
 *   back after being gone a while (status "returning"). A visitor's
 *   own visitCount (in visitors.js) is the count for THAT one person;
 *   this is the running total across everyone.
 * - Refreshes/clicks/redirects within the same open visit never reach
 *   here at all (status "duplicate" — see handleVisit in booking.js).
 * - Bookings: bumped only when the admin/guide taps ✅ Confirm under a
 *   booking message — i.e. it's a count of bookings the telegram bot
 *   admin has actually confirmed, not just submitted.
 *
 * Counts live in KV as plain numbers (not JSON blobs) so bumping them is
 * a cheap read-increment-write, same pattern as everything else here:
 * Telegram is the visible record, KV is just the fast cache.
 */
import { tgSendMessage, tgEditMessageText, tgPinMessage } from "./telegram.js";

async function getNum(env, key) {
  const raw = await env.BOOKINGS.get(key);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}
async function setNum(env, key, value) {
  await env.BOOKINGS.put(key, String(value));
}

export async function getLiveStats(env) {
  const visitors = await getNum(env, "stats:visitors");
  const returningVisits = await getNum(env, "stats:returningVisits");
  const bookings = await getNum(env, "stats:bookings");
  return { visitors, returningVisits, bookings };
}

function renderStatsText(visitors, returningVisits, bookings) {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return (
    `📊 <b>Live Stats</b>\n` +
    `🆕 New visitors: <b>${visitors}</b>\n` +
    `🔁 Returning visits: <b>${returningVisits}</b>\n` +
    `✅ Confirmed bookings: <b>${bookings}</b>\n\n` +
    `<i>Updates automatically — pinned so it's always visible. Last change: ${stamp}</i>`
  );
}

async function pushStatsMessage(env, visitors, returningVisits, bookings) {
  const chatId = env.TELEGRAM_ADMIN_CHAT_ID;
  if (!chatId) return; // no admin chat configured yet — skip silently
  const text = renderStatsText(visitors, returningVisits, bookings);
  const existingMsgId = await env.BOOKINGS.get("statsmsg");

  if (existingMsgId) {
    const r = await tgEditMessageText(env, chatId, Number(existingMsgId), text);
    if (r && r.ok) return;
    // message was deleted / too old to edit — fall through and send fresh
  }
  const sent = await tgSendMessage(env, chatId, text);
  if (sent && sent.ok && sent.result && sent.result.message_id) {
    await env.BOOKINGS.put("statsmsg", String(sent.result.message_id));
    tgPinMessage(env, chatId, sent.result.message_id).catch(() => {});
  }
}

// Bumped once per brand-new visitor (never for a repeat visit — see
// visitors.js#recordVisit, status "new").
export async function bumpNewVisitor(env) {
  const visitors = (await getNum(env, "stats:visitors")) + 1;
  await setNum(env, "stats:visitors", visitors);
  const returningVisits = await getNum(env, "stats:returningVisits");
  const bookings = await getNum(env, "stats:bookings");
  await pushStatsMessage(env, visitors, returningVisits, bookings);
  return visitors;
}

// Bumped every time an already-known visitor visits again (status
// "returning") — never for their first-ever visit.
export async function bumpReturningVisit(env) {
  const returningVisits = (await getNum(env, "stats:returningVisits")) + 1;
  await setNum(env, "stats:returningVisits", returningVisits);
  const visitors = await getNum(env, "stats:visitors");
  const bookings = await getNum(env, "stats:bookings");
  await pushStatsMessage(env, visitors, returningVisits, bookings);
  return returningVisits;
}

export async function bumpBookings(env) {
  const bookings = (await getNum(env, "stats:bookings")) + 1;
  await setNum(env, "stats:bookings", bookings);
  const visitors = await getNum(env, "stats:visitors");
  const returningVisits = await getNum(env, "stats:returningVisits");
  await pushStatsMessage(env, visitors, returningVisits, bookings);
  return bookings;
}

export async function resetStats(env) {
  await setNum(env, "stats:visitors", 0);
  await setNum(env, "stats:returningVisits", 0);
  await setNum(env, "stats:bookings", 0);
  await pushStatsMessage(env, 0, 0, 0);
}
