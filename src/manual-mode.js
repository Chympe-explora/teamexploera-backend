/**
 * manual-mode.js — "📵 Manual WhatsApp Mode", a single site-wide switch
 * the admin can flip from the Telegram bot's main menu.
 *
 * OFF (default / normal operation): unchanged from before — a visitor's
 * Submit posts straight to Telegram (to an assigned guide's DM if one
 * covers the site/package, or to the group otherwise), the visitor's
 * browser gets a live bookingId and polls /api/status for it, and
 * Confirm/Reject works exactly as it always has.
 *
 * ON: for every visitor, site-wide:
 *   1. Guide auto-assignment is skipped entirely — the booking is
 *      posted straight to the group (TELEGRAM_CHAT_ID) ONLY, tagged
 *      "📵 Manual booking" so it's easy to tell apart, with the same
 *      working ✅ Confirm / ❌ Reject / 🚫 Block buttons and the same
 *      receipt attachment a normal booking gets (see handleSubmit in
 *      booking.js). This happens immediately on submit — no extra step.
 *   2. The visitor's browser is ALSO told `manualMode: true` in the
 *      /api/submit response — instead of starting the normal live
 *      "waiting for confirmation" status poll, it opens the visitor's
 *      own WhatsApp with every booking detail prefilled, addressed to
 *      the admin, including the bookingId as a short code. This is in
 *      addition to the group post above, not instead of it — belt and
 *      braces, so the admin sees the booking both places.
 *   3. As a safety net only: if the group post in step 1 fails for some
 *      reason (bad bot token, bot never added to the group, etc.), the
 *      booking is still recorded — flagged `pendingPost: true` instead
 *      of being lost — and can be posted later by pasting its code into
 *      the bot (reusing the exact same "paste a booking code" flow that
 *      already existed for the "no guide response yet" fallback — see
 *      BOOKING_CODE_RE / handleBookingCodeLookup in telegram-bot.js).
 *      In the normal, working case this never comes into play.
 *
 * Turning the switch back OFF instantly restores the normal flow —
 * guide auto-assignment and live status tracking — for every NEW
 * submission. Nothing needs to be migrated.
 *
 * Stored the same way every other admin-editable setting in this project
 * is: a small doc, cached in KV, permanently logged/visible as a message
 * in the Telegram admin chat (see store.js#getDoc/saveDoc) — no new KV
 * namespace, no wrangler.toml change.
 */

import { getDoc, saveDoc } from "./store.js";

const DOC_KEY = "settings:manualMode";

export async function isManualModeEnabled(env) {
  const settings = await getDoc(env, DOC_KEY, { enabled: false });
  return !!(settings && settings.enabled);
}

export async function setManualModeEnabled(env, enabled) {
  const on = !!enabled;
  await saveDoc(
    env,
    DOC_KEY,
    { enabled: on },
    {
      logChange: on
        ? "📵 Manual WhatsApp Mode turned ON 🟢 — new bookings now post to the group only (no guide assignment) and the visitor is also sent to WhatsApp with a code."
        : "📵 Manual WhatsApp Mode turned OFF 🔴 — normal booking flow restored (guide auto-assignment and live status tracking back on).",
    }
  );
  return on;
}
