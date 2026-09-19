/**
 * chympe-booking-backend
 * -----------------------------------------------------------------------
 * Cloudflare Worker that sits behind booking-bridge.js on any Krem/Chympe
 * site. Telegram is the storage: every draft, receipt, and submitted
 * booking is posted (or edited) as a message in your Telegram chat, so
 * the chat itself is the permanent, human-readable record. A small KV
 * namespace is used only as a fast lookup cache so the visitor's browser
 * can poll "is this booking confirmed yet?" without hitting Telegram's
 * API on every poll, and so a draft can be *edited* in place instead of
 * spamming a new message every 1.5s while someone types.
 *
 * Endpoints (all under /api, called by booking-bridge.js):
 *   POST /api/draft            { sessionId, siteId, data }
 *   POST /api/receipt          multipart: sessionId, siteId, caption, file
 *   POST /api/submit           { sessionId, siteId, data } -> { bookingId }
 *   GET  /api/status/:id       -> { status }
 *   POST /telegram-webhook     Telegram calls this when the guide taps
 *                              Confirm / Reject under a booking message.
 *
 * Required secrets / vars (set with `wrangler secret put ...` or in the
 * Cloudflare dashboard — see DEPLOY.md):
 *   TELEGRAM_BOT_TOKEN     - from @BotFather
 *   TELEGRAM_CHAT_ID       - the guide's chat/group id the bot posts to
 *   TELEGRAM_WEBHOOK_SECRET- random string, also set on the webhook URL
 *   ALLOWED_ORIGIN         - e.g. https://your-site.pages.dev ("*" for dev)
 *
 * Required binding:
 *   BOOKINGS  - a KV namespace (see wrangler.toml)
 */

import { bumpVisitors, bumpBookings } from "./stats.js";
import { isSessionActive, isSessionBlocked, toggleSessionBlocked } from "./conversations.js";
import { getEligibleGuides, assignBookingToGuide, getGuide, getGuideByChatId } from "./guides.js";
// Booking/refund status reads+writes go through status-store.js, NOT
// straight to KV — see that file's header comment for why (KV's
// eventual consistency was the cause of "confirm sometimes doesn't show
// up" on the visitor's side).
import { getStatus, setStatus, getRefundStatus, setRefundStatus } from "./status-store.js";
import { honeypotTripped } from "./security.js";
import { isManualModeEnabled } from "./manual-mode.js";

export function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  };
}

export function json(data, env, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json", ...corsHeaders(env) },
  });
}

// ---------------------------------------------------------------------
// EDGE CACHE for cheap, high-traffic public GET endpoints (content,
// prices, images, highlights, discounts, reviews, ratings). These are
// called on every single page load, but the underlying data only
// changes when an admin edits something through the Telegram bot — so
// serving a short-lived cached copy from Cloudflare's edge (skipping
// the Worker invocation AND the KV read entirely on a hit) is safe.
//
// IMPORTANT: a `Cache-Control` header alone does NOT get a Worker's
// JSON response cached by Cloudflare's CDN — that only happens
// automatically for static assets. Reaching the edge requires calling
// the Cache API explicitly, which is what this helper does. `ttlSeconds`
// is deliberately short (seconds, not hours) so a change made in the
// Telegram admin bot shows up for visitors almost immediately, while
// still absorbing the vast majority of read traffic during that window.
export async function withEdgeCache(request, ctx, ttlSeconds, compute) {
  if (request.method !== "GET" || typeof caches === "undefined" || !caches.default) {
    return compute();
  }
  const cache = caches.default;
  const cacheKey = new Request(request.url, request);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const response = await compute();
  if (!response.ok) return response;

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", `public, max-age=${ttlSeconds}`);
  const fresh = new Response(response.body, { status: response.status, headers });
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(cache.put(cacheKey, fresh.clone()));
  } else {
    await cache.put(cacheKey, fresh.clone());
  }
  return fresh;
}

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function tgSendPhotoOrDoc(env, formFields, file) {
  const form = new FormData();
  form.append("chat_id", env.TELEGRAM_CHAT_ID);
  form.append("caption", formFields.caption || "");
  const isImage = /^image\//.test(file.type || "");
  form.append(isImage ? "photo" : "document", file, file.name || "receipt");
  const endpoint = isImage ? "sendPhoto" : "sendDocument";
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${endpoint}`, {
    method: "POST",
    body: form,
  });
  const res = await r.json();
  return { ...res, isImage };
}

// Re-send a file already sitting on Telegram's CDN (by file_id) — no
// re-upload needed. Used to attach the receipt the visitor already sent
// to the final booking message. photo captions are capped at 1024 chars
// by Telegram, so callers must check length before relying on this.
async function tgSendPhotoByIdWithButtons(env, fileId, caption, replyMarkup, silent, chatId) {
  return tg(env, "sendPhoto", {
    chat_id: chatId || env.TELEGRAM_CHAT_ID,
    photo: fileId,
    caption,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
    disable_notification: !!silent,
  });
}
async function tgSendDocumentByIdWithButtons(env, fileId, caption, replyMarkup, silent, chatId) {
  return tg(env, "sendDocument", {
    chat_id: chatId || env.TELEGRAM_CHAT_ID,
    document: fileId,
    caption,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
    disable_notification: !!silent,
  });
}
async function tgEditMessageCaption(env, chatId, messageId, caption) {
  return tg(env, "editMessageCaption", {
    chat_id: chatId || env.TELEGRAM_CHAT_ID,
    message_id: messageId,
    caption,
    parse_mode: "HTML",
  });
}

// Triggers Telegram's native "…is typing" bubble in the admin chat — the
// same WhatsApp-style live indicator, just driven by a visitor filling in
// the booking form instead of a chat message. Telegram clears it on its
// own after ~5 seconds, so this just needs to be re-sent while the
// visitor keeps typing (handleDraft already fires on every field change).
// Fails silently — a missed typing bubble should never break a booking.
async function tgTyping(env) {
  try {
    return await tg(env, "sendChatAction", { chat_id: env.TELEGRAM_CHAT_ID, action: "typing" });
  } catch (e) {
    return { ok: false };
  }
}

function fmtData(data) {
  return Object.entries(data || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `<b>${escapeHtml(k)}:</b> ${escapeHtml(String(v))}`)
    .join("\n");
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function newId() {
  return crypto.randomUUID().slice(0, 8);
}

// Silent visit ping — fired the moment a visitor opens/scrolls the site.
// Never shown to the visitor; just a Telegram heads-up for the admin.
export async function handleVisit(request, env) {
  const { sessionId, siteId, path, referrer } = await request.json();
  const text =
    `\ud83d\udc40 <b>New visitor — ${escapeHtml(siteId || "site")}</b>\n` +
    `page: ${escapeHtml(path || "/")}\n` +
    (referrer ? `from: ${escapeHtml(referrer)}\n` : "") +
    `session: ${escapeHtml(sessionId || "")}`;
  await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML", text });
  await bumpVisitors(env).catch(() => {});
  return json({ ok: true }, env);
}

// Silent destination/package tap — fired when a visitor taps a specific
// destination or package card, before they've filled anything in.
export async function handleTap(request, env) {
  const { sessionId, siteId, destination } = await request.json();
  const text =
    `\ud83d\udc49 <b>Tapped a destination — ${escapeHtml(siteId || "site")}</b>\n` +
    `destination: ${escapeHtml(destination || "unknown")}\n` +
    `session: ${escapeHtml(sessionId || "")}`;
  await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML", text });
  return json({ ok: true }, env);
}

// Drafts are edited in place (one Telegram message per session) instead of
// posting a new message every time the visitor types — the message id is
// cached in KV against the sessionId.
//
// SPEED: the actual Telegram network calls (typing bubble + send/edit)
// are pushed into ctx.waitUntil() and the visitor's browser gets an
// immediate { ok: true } — a live draft preview is a nice-to-have for
// the admin, not something the visitor should ever wait on. If ctx
// isn't available for some reason (older caller), falls back to the
// previous fully-awaited behavior so nothing breaks.
export async function handleDraft(request, env, ctx) {
  const { sessionId, siteId, data } = await request.json();
  if (!sessionId) return json({ ok: false }, env, 400);

  const text = `\u270f\ufe0f <b>Draft — ${escapeHtml(siteId || "site")}</b>\n${fmtData(data)}`;
  const existingMsgId = await env.BOOKINGS.get(`draftmsg:${sessionId}`);

  async function sendDraft() {
    await tgTyping(env);
    let res;
    if (existingMsgId) {
      res = await tg(env, "editMessageText", {
        chat_id: env.TELEGRAM_CHAT_ID,
        message_id: Number(existingMsgId),
        parse_mode: "HTML",
        text,
      });
      if (!res.ok) {
        // original message may have been deleted / too old to edit — send a fresh one
        res = await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML", text });
      }
    } else {
      res = await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML", text });
    }
    if (res.ok && res.result && res.result.message_id) {
      await env.BOOKINGS.put(`draftmsg:${sessionId}`, String(res.result.message_id), { expirationTtl: 60 * 60 * 24 });
    }
  }

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(sendDraft().catch(() => {}));
  } else {
    await sendDraft().catch(() => {});
  }
  return json({ ok: true }, env);
}

// Fired the moment a visitor taps "Pay Now" (before they've paid or
// submitted anything). Sends a brand-new, distinct Telegram message with
// every detail collected so far, so the admin sees it immediately —
// separate from the live-editing draft message so neither gets overwritten.
//
// SPEED: this is an FYI ping, same as /api/visit and /api/tap — the
// visitor doesn't need to wait for Telegram to accept it, so it's fired
// via ctx.waitUntil and the browser gets an instant response.
export async function handlePayNow(request, env, ctx) {
  const { sessionId, siteId, data } = await request.json();
  const text =
    `\ud83d\udcb3 <b>Pay Now tapped — ${escapeHtml(siteId || "site")}</b>\n${fmtData(data)}\n\n` +
    `<i>session: ${escapeHtml(sessionId || "")}</i>`;
  const send = tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML", text });
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(send.catch(() => {}));
  } else {
    await send.catch(() => {});
  }
  return json({ ok: true }, env);
}

export async function handleReceipt(request, env) {
  const form = await request.formData();
  const sessionId = form.get("sessionId");
  const siteId = form.get("siteId");
  const caption = form.get("caption") || "";
  const file = form.get("file");
  if (!file) return json({ ok: false, error: "no file" }, env, 400);

  const res = await tgSendPhotoOrDoc(env, { caption: `\ud83e\uddfe Receipt — ${siteId || "site"}\n${caption}\nsession: ${sessionId}` }, file);

  // Remember this receipt's Telegram file_id against the sessionId so the
  // final /api/submit booking message can re-attach the SAME receipt
  // (no re-upload needed) alongside the Confirm/Reject buttons — instead
  // of the receipt sitting in an earlier, disconnected message. Short TTL:
  // this is only a bridge between "receipt uploaded" and "booking submitted",
  // which normally happen a minute or two apart.
  if (res.ok && sessionId) {
    const fileId = res.isImage
      ? (res.result.photo && res.result.photo[res.result.photo.length - 1]?.file_id)
      : (res.result.document && res.result.document.file_id);
    if (fileId) {
      await env.BOOKINGS.put(
        `receiptfile:${sessionId}`,
        JSON.stringify({ fileId, isImage: res.isImage }),
        { expirationTtl: 60 * 60 * 2 }
      );
    }
  }

  return json({ ok: !!res.ok, error: res.ok ? undefined : (res.description || "telegram send failed") }, env, res.ok ? 200 : 502);
}

// Sends one booking (text + Confirm/Reject buttons, optionally with a
// receipt photo/doc) to a single chat id, handling the same three
// shapes handleSubmit always has: receipt fits in the caption, receipt
// too long for a caption (sent separately, details+buttons follow), or
// no receipt at all. Pass replyMarkup: null for an informational-only
// copy with no buttons at all (used for the group's copy when a guide
// has already been assigned the actionable one — see handleSubmit).
// Sends one booking (text + Confirm/Reject buttons, optionally with a
// receipt photo/doc) to a single chat id, handling the same three
// shapes handleSubmit always has: receipt fits in the caption, receipt
// too long for a caption (sent separately, details+buttons follow), or
// no receipt at all. Pass replyMarkup: null for an informational-only
// copy with no buttons at all (used for the group's copy when a guide
// has already been assigned the actionable one — see handleSubmit).
// Exported so telegram-bot.js's Manual WhatsApp Mode can post a
// previously-unsent booking the exact same way a normal submission
// would have — see postPendingBookingToGroup there.
export async function sendBookingToOne(env, chatId, text, replyMarkup, receipt, silent) {
  if (receipt && text.length <= 1024) {
    return receipt.isImage
      ? tgSendPhotoByIdWithButtons(env, receipt.fileId, text, replyMarkup, silent, chatId)
      : tgSendDocumentByIdWithButtons(env, receipt.fileId, text, replyMarkup, silent, chatId);
  }
  if (receipt) {
    const shortCaption = `\ud83e\uddfe <b>Payment Receipt</b>`;
    (receipt.isImage
      ? tgSendPhotoByIdWithButtons(env, receipt.fileId, shortCaption, undefined, silent, chatId)
      : tgSendDocumentByIdWithButtons(env, receipt.fileId, shortCaption, undefined, silent, chatId)
    ).catch(() => {});
  }
  return tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML", text, reply_markup: replyMarkup || undefined, disable_notification: !!silent });
}

// A submitted booking gets its own bookingId (used by the browser to poll
// status) and its own Telegram message(s) with inline Confirm/Reject
// buttons. The bookingId <-> Telegram message id mapping and the full
// booking data are both cached in KV; Telegram remains the durable,
// readable log.
export async function handleSubmit(request, env, ctx) {
  const { sessionId, siteId, data } = await request.json();

  // 🍯 Honeypot — a hidden form field ("website_url") no human visitor
  // ever sees or fills in, but a dumb auto-fill bot often does. If it's
  // filled, quietly accept (so the bot doesn't learn to retry) but never
  // touch Telegram or KV with it. See security.js#honeypotTripped and
  // the frontend's hidden field in booking-bridge.js.
  if (honeypotTripped(data)) {
    return json({ ok: true, bookingId: newId() }, env);
  }

  // A blocked chat id (see conversations.js / the "🚫 Block This Chat ID
  // From Booking" button) still gets a bookingId and their booking is
  // still recorded in KV — nothing errors out or looks broken on their
  // end — it just never reaches Telegram, so a blocked/spam visitor
  // can't put anything in front of the admin anymore.
  const blocked = sessionId ? await isSessionBlocked(env, sessionId) : false;
  if (blocked) {
    const bookingId = newId();
    await setStatus(env, bookingId, "pending");
    await env.BOOKINGS.put(`booking:${bookingId}`, JSON.stringify({ sessionId, siteId, data, blocked: true }), { expirationTtl: 60 * 60 * 24 * 30 });
    return json({ ok: true, bookingId }, env);
  }

  // One pending booking per visitor at a time — stops an accidental
  // double-submit (double-tap, browser back-then-resubmit) from
  // creating a second Confirm/Reject message for the same trip. If
  // their previous booking has already been decided (confirmed/
  // cancelled), a new one is allowed as normal.
  if (sessionId) {
    const existingId = await env.BOOKINGS.get(`pendingbooking:${sessionId}`);
    if (existingId) {
      const existingStatus = await getStatus(env, existingId);
      // "pending" = a normal booking already posted to Telegram and
      // awaiting Confirm/Reject. "awaiting_admin" = a 📵 Manual WhatsApp
      // Mode booking that hasn't been pasted into the bot yet — same
      // one-at-a-time rule applies so repeated taps of Submit can't open
      // a dozen WhatsApp chats for a dozen near-duplicate bookings.
      if (existingStatus === "pending" || existingStatus === "awaiting_admin") {
        return json(
          { ok: false, error: "You already have a booking awaiting confirmation. Please wait for that one to be confirmed or rejected first.", bookingId: existingId, alreadyPending: true },
          env,
          409
        );
      }
    }
  }

  const bookingId = newId();

  // If this visitor already uploaded a payment receipt (during the Pay
  // Now step), re-attach that SAME Telegram file (no re-upload) to this
  // booking message so whoever handles it sees the receipt and the
  // Confirm/Reject buttons together, in one place.
  const receiptRaw = sessionId ? await env.BOOKINGS.get(`receiptfile:${sessionId}`) : null;
  const receipt = receiptRaw ? JSON.parse(receiptRaw) : null;

  // 📵 Manual WhatsApp Mode (see manual-mode.js) — when ON, this
  // booking still posts to Telegram immediately, exactly like normal,
  // EXCEPT it always goes to the group only (guide auto-assignment is
  // skipped entirely, on purpose) and gets a "📵 Manual" tag so it's
  // obviously distinguishable in the group. The visitor's browser is
  // additionally told `manualMode: true` so it ALSO opens WhatsApp with
  // this bookingId as a code — belt and braces, so the admin sees it
  // both places.
  const manualMode = await isManualModeEnabled(env);

  // Prefer the fully pretty-formatted text the site already builds for
  // WhatsApp (ref no, itemized breakdown, totals, payment method — the
  // same layout the guide sees on WhatsApp) so the Telegram message
  // matches it 1:1. Falls back to a plain field list for older frontends
  // that don't send `data.message` yet.
  const bodyText = data && data.message
    ? escapeHtml(data.message)
    : fmtData(data);
  const text = manualMode
    ? `\ud83d\udcf5 <b>Manual booking</b>\n\n${bodyText}\n\n<i>ref: ${bookingId}</i>`
    : `${bodyText}\n\n<i>ref: ${bookingId}</i>`;

  const actionableMarkup = {
    inline_keyboard: [
      [
        { text: "\u2705 Confirm", callback_data: `confirm:${bookingId}` },
        { text: "\u274c Reject", callback_data: `cancel:${bookingId}` },
      ],
      // Lets whoever's handling this remove this specific visitor's
      // chat id from ever sending a booking notification again, right
      // from the booking itself. See handleBookingCallback's
      // "blockvisitor" case below.
      [{ text: "\ud83d\udeab Block This Chat ID From Booking", callback_data: `blockvisitor:${bookingId}` }],
    ],
  };

  // If this visitor is currently marked 🟢 Active from Telegram (see
  // conversations.js), an admin already has eyes on them directly, so
  // this booking message is sent silently (no notification sound/badge)
  // instead of being skipped outright — it still lands with working
  // Confirm/Reject buttons, it just doesn't interrupt anyone. When not
  // active, this behaves exactly as it always has.
  const activeElsewhere = sessionId ? await isSessionActive(env, sessionId) : false;

  // ---- who gets the actionable message? ----
  // Package-based fan-out (see guides.js#getEligibleGuides): EVERY
  // active, booking-access-enabled, linked guide who covers this site +
  // package gets the SAME actionable Confirm/Reject message, all at
  // once — whichever of them taps Confirm first is the one who keeps
  // it (see handleBookingCallback below, which settles the race). The
  // admin group still gets a copy, but purely informational (no
  // buttons) — it's told who was notified, nothing more. If no
  // eligible guide exists, the group falls back to being the
  // actionable recipient, exactly like before guides existed at all.
  //
  // 📵 Manual WhatsApp Mode always skips this entirely — group only,
  // never a guide — regardless of whether an eligible guide exists.
  const packageKey = data && data.packageKey;
  const eligibleGuides = manualMode ? [] : siteId ? await getEligibleGuides(env, siteId, packageKey) : [];

  if (!eligibleGuides.length && !env.TELEGRAM_CHAT_ID) {
    return json({ ok: false, error: "No Telegram chat is configured to receive bookings." }, env, 502);
  }

  let sendResults = [];
  let groupInfoText = null;
  if (eligibleGuides.length) {
    sendResults = await Promise.all(
      eligibleGuides.map((g) => sendBookingToOne(env, g.chatId, text, actionableMarkup, receipt, activeElsewhere))
    );
    const names = eligibleGuides.map((g) => escapeHtml(g.name)).join(", ");
    groupInfoText =
      eligibleGuides.length === 1
        ? `\u2139\ufe0f <b>New booking</b> — sent to <b>${names}</b> for confirmation.\n\n${text}`
        : `\u2139\ufe0f <b>New booking</b> — sent to ${eligibleGuides.length} available guides (${names}); whoever confirms first gets it.\n\n${text}`;
  } else {
    sendResults = [await sendBookingToOne(env, env.TELEGRAM_CHAT_ID, text, actionableMarkup, receipt, activeElsewhere)];
  }

  const anyOk = sendResults.some((r) => r && r.ok);

  // IMPORTANT: only report success to the visitor's browser if the
  // booking message actually reached at least one recipient on
  // Telegram. Previously this always returned { ok: true }, even when
  // the send failed (bad/missing bot token, wrong chat id, bot never
  // started, etc.) — so a visitor could "successfully" submit a
  // booking that nobody ever saw, with no error anywhere. Now a
  // total-failure send is reported back as an error so it can be
  // surfaced in the UI instead of disappearing silently.
  //
  // 📵 Manual WhatsApp Mode gets ONE extra fallback here: if the group
  // send itself fails (bad token, bot never started in the group, etc.)
  // the booking is still recorded — flagged `pendingPost: true` — so it
  // isn't lost. The visitor still gets `manualMode: true` (WhatsApp is
  // their real record of it either way), and the admin can recover it
  // later by pasting its code into the bot, which posts it then instead.
  if (!anyOk) {
    if (manualMode) {
      await setStatus(env, bookingId, "awaiting_admin");
      await env.BOOKINGS.put(
        `booking:${bookingId}`,
        JSON.stringify({ sessionId, siteId, data, assignedGuideId: null, receipt: receipt || null, pendingPost: true }),
        { expirationTtl: 60 * 60 * 24 * 30 }
      );
      if (sessionId) {
        await env.BOOKINGS.put(`pendingbooking:${sessionId}`, bookingId, { expirationTtl: 60 * 60 * 24 * 30 });
        await env.BOOKINGS.delete(`receiptfile:${sessionId}`).catch(() => {});
      }
      return json({ ok: true, bookingId, manualMode: true }, env);
    }
    const firstError = sendResults.find((r) => r && r.description);
    return json({ ok: false, error: (firstError && firstError.description) || "telegram send failed" }, env, 502);
  }

  const messageRefs = [];
  if (eligibleGuides.length) {
    sendResults.forEach((res, i) => {
      if (res && res.ok && res.result && res.result.message_id) {
        messageRefs.push({ chatId: eligibleGuides[i].chatId, messageId: res.result.message_id });
      }
    });
  } else if (sendResults[0] && sendResults[0].ok && sendResults[0].result && sendResults[0].result.message_id) {
    messageRefs.push({ chatId: env.TELEGRAM_CHAT_ID, messageId: sendResults[0].result.message_id });
  }

  // SPEED + reliability: the visitor already has everything they need
  // (bookingId), so neither the group's informational copy nor the KV
  // bookkeeping needs to finish before responding. Deferred via
  // ctx.waitUntil when available.
  async function sendInfoAndPersist() {
    if (eligibleGuides.length && env.TELEGRAM_CHAT_ID && groupInfoText) {
      // Informational only — no reply_markup at all, per spec: the
      // group never gets actionable buttons once guides are handling it.
      await sendBookingToOne(env, env.TELEGRAM_CHAT_ID, groupInfoText, null, receipt, true).catch(() => {});
    }
    // Each guide has their own guideBookings:<id> key, so these writes
    // never touch the same KV key and are safe to run concurrently
    // instead of one-at-a-time.
    await Promise.all(eligibleGuides.map((g) => assignBookingToGuide(env, g.id, bookingId)));

    await setStatus(env, bookingId, "pending");
    // receipt (fileId/isImage) is saved onto the durable booking record
    // itself here — not just the short-TTL `receiptfile:<sessionId>` key
    // below (which gets deleted right after this) — so an admin can look
    // up this booking by its code later (see handleBookingCodeLookup in
    // telegram-bot.js) and still get the receipt re-sent, even long
    // after the visitor's session-scoped cache entry has expired.
    //
    // assignedGuideId starts null even when guides were notified — it's
    // only set once someone actually confirms (see
    // handleBookingCallback), since with multiple guides notified at
    // once there's no single "the" guide until one of them wins the
    // race. eligibleGuideIds records who was in the race at all, so a
    // reject from one of several notified guides can be told apart from
    // a reject when there was only ever one recipient (see
    // handleBookingCallback).
    await env.BOOKINGS.put(
      `booking:${bookingId}`,
      JSON.stringify({
        sessionId,
        siteId,
        data,
        assignedGuideId: null,
        eligibleGuideIds: eligibleGuides.map((g) => g.id),
        declinedGuideIds: [],
        receipt: receipt || null,
      }),
      { expirationTtl: 60 * 60 * 24 * 30 }
    );
    if (messageRefs.length) {
      await env.BOOKINGS.put(`bookingmsg:${bookingId}`, JSON.stringify(messageRefs), { expirationTtl: 60 * 60 * 24 * 30 });
    }
    if (sessionId) {
      await env.BOOKINGS.put(`pendingbooking:${sessionId}`, bookingId, { expirationTtl: 60 * 60 * 24 * 30 });
      await env.BOOKINGS.delete(`receiptfile:${sessionId}`).catch(() => {});
    }
  }

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(sendInfoAndPersist());
  } else {
    await sendInfoAndPersist();
  }

  return json({ ok: true, bookingId, manualMode }, env);
}

// Called by the central webhook dispatcher in index.js for callback
// taps that happen in the guide/booking chat (Confirm / Reject under a
// booking message) — kept separate from the admin bot's own button
// vocabulary so the two never collide.
// GET /api/status/:id — polled by the visitor's browser every ~1.5s (see
// booking-bridge.js's watchStatus). Once confirmed, also hands back the
// name + WhatsApp number of whichever guide actually confirmed it (looked
// up live from booking:<id>.assignedGuideId + the current guide record,
// so it always reflects the guide's latest saved number — not whatever
// it was at booking time) so the visitor's "Message Your Guide" button
// can go straight to them instead of the site's general admin number.
// Both are null when there's no assigned guide, or that guide hasn't set
// a number yet — the frontend falls back to the admin WhatsApp number in
// that case.
export async function handleStatusCheck(bookingId, env) {
  const status = await getStatus(env, bookingId);
  let guideName = null;
  let guidePhone = null;
  if (status === "confirmed") {
    const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
    if (bookingRaw) {
      try {
        const booking = JSON.parse(bookingRaw);
        if (booking.assignedGuideId) {
          const guide = await getGuide(env, booking.assignedGuideId);
          if (guide) {
            guideName = guide.name;
            guidePhone = guide.phone || null;
          }
        }
      } catch (e) {
        // malformed record — just fall back to no guide contact info
      }
    }
  }
  return json({ status, guideName, guidePhone }, env);
}

// Edits ONE Telegram copy of a booking message (text or media-caption)
// to show a final badge and clears its buttons. Shared by the
// full-settle path below (every recipient, once a booking is truly
// decided) and the single-message paths in handleBookingCallback (a
// race loser tapping a button after someone else already won, or one
// guide declining while others are still in the running).
async function stampBookingMessage(env, chatId, messageId, cb, badgeHtml) {
  try {
    const isMedia = !!(cb.message && (cb.message.photo || cb.message.document));
    const originalCaption = (cb.message && cb.message.caption) || "";
    const originalText = (cb.message && cb.message.text) || "";
    if (isMedia) {
      await tgEditMessageCaption(env, chatId, Number(messageId), `${originalCaption}\n\n<b>${badgeHtml}</b>`);
    } else {
      await tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: Number(messageId),
        parse_mode: "HTML",
        text: `${originalText}\n\n<b>${badgeHtml}</b>`,
      });
    }
    await tg(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: Number(messageId), reply_markup: { inline_keyboard: [] } }).catch(() => {});
  } catch (e) {
    // One recipient's copy failing to edit (they deleted their chat
    // with the bot, blocked it, etc.) shouldn't break anything else.
  }
}

// Reads the {chatId, messageId}[] this booking's actionable message(s)
// were sent as — one entry per eligible guide it was fanned out to, or
// a single group entry when no guide was eligible.
async function getBookingMsgRefs(env, bookingId) {
  const msgRefsRaw = await env.BOOKINGS.get(`bookingmsg:${bookingId}`);
  if (!msgRefsRaw) return [];
  try {
    const parsed = JSON.parse(msgRefsRaw);
    // Back-compat: bookings created before guide fan-out existed stored
    // a single numeric message_id string (always in the main group),
    // not an array of {chatId, messageId}.
    return Array.isArray(parsed) ? parsed : [{ chatId: env.TELEGRAM_CHAT_ID, messageId: parsed }];
  } catch (e) {
    return [{ chatId: env.TELEGRAM_CHAT_ID, messageId: Number(msgRefsRaw) }];
  }
}

export async function handleBookingCallback(cb, env) {
  if (!cb || !cb.data) return;

  const [action, bookingId] = cb.data.split(":");
  if ((action === "confirm" || action === "cancel") && bookingId) {
    const newStatus = action === "confirm" ? "confirmed" : "cancelled";
    const currentStatus = await getStatus(env, bookingId);

    // Multi-guide race, already lost: another guide (or the admin, via
    // a code-lookup Confirm/Reject) already settled this booking before
    // this tap landed. Just tell them and refresh THEIR copy to match
    // the real outcome — every other copy was already updated by
    // whoever settled it, so there's nothing left to do here.
    //
    // ONE exception: currentStatus === "cancelled" (every guide declined
    // it) plus action === "confirm" is an intentional ADMIN OVERRIDE, not
    // a stale tap — it's the ✅ Confirm button on the code-lookup message
    // the admin gets after the visitor reaches out on WhatsApp post-
    // rejection (see handleBookingCodeLookup in telegram-bot.js). Let
    // that one combination fall through to the normal settle path below
    // instead of bailing out here. Re-tapping ❌ Reject on an
    // already-cancelled booking still bails out as a harmless no-op, and
    // "confirmed" is still always final either way.
    const isAdminOverrideOfRejection = currentStatus === "cancelled" && action === "confirm";
    if (currentStatus && currentStatus !== "pending" && !isAdminOverrideOfRejection) {
      tg(env, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: currentStatus === "confirmed" ? "Already confirmed — another guide got there first." : "This booking was already settled.",
        show_alert: true,
      }).catch(() => {});
      if (cb.message) {
        const badge = currentStatus === "confirmed" ? "\u2705 Already confirmed by another guide" : "\u274c Already settled";
        await stampBookingMessage(env, cb.message.chat.id, cb.message.message_id, cb, badge);
      }
      return;
    }

    // A REJECT only settles the booking once EVERY guide it was fanned
    // out to has rejected — one guide declining shouldn't cancel a
    // booking the others haven't even responded to yet. A CONFIRM is
    // always final (first one in wins), so this only branches for
    // "cancel", and only when there was more than one guide in the race.
    if (action === "cancel") {
      const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
      const booking = bookingRaw ? JSON.parse(bookingRaw) : null;
      if (booking && Array.isArray(booking.eligibleGuideIds) && booking.eligibleGuideIds.length > 1 && cb.message) {
        const decliner = await getGuideByChatId(env, cb.message.chat.id);
        const declinedSoFar = new Set(booking.declinedGuideIds || []);
        if (decliner) declinedSoFar.add(decliner.id);
        const allDeclined = booking.eligibleGuideIds.every((id) => declinedSoFar.has(id));
        if (!allDeclined) {
          booking.declinedGuideIds = Array.from(declinedSoFar);
          await env.BOOKINGS.put(`booking:${bookingId}`, JSON.stringify(booking), { expirationTtl: 60 * 60 * 24 * 30 });
          tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "You declined — still waiting on the other guide(s)." }).catch(() => {});
          await stampBookingMessage(env, cb.message.chat.id, cb.message.message_id, cb, "\u274c You declined this one");
          return; // booking stays pending — the others can still confirm it
        }
        // Every eligible guide has now declined — fall through and
        // settle the booking as rejected, same as a single-guide reject.
      }
    }

    // ---- settle the booking (confirm, or a reject nobody's left to override) ----

    // Flip the status FIRST, before touching the Telegram message. The
    // visitor's browser is polling /api/status every ~1.5s — the instant
    // this write lands, the next poll picks it up and the site flips to
    // Confirmed/Rejected, even if the Telegram message edit below is
    // slow or fails for some reason. This goes through status-store.js
    // (a Durable Object), not raw KV, specifically so "the instant this
    // write lands" is actually true everywhere, immediately — see that
    // file's header comment.
    await setStatus(env, bookingId, newStatus);
    if (newStatus === "confirmed") {
      await bumpBookings(env).catch(() => {});
      // Record WHICH guide actually confirmed it (when the tap came
      // from a guide's own chat, not the admin group or a code-lookup)
      // so the visitor's "Message Your Guide" button goes straight to
      // them — see handleStatusCheck above, which reads this back.
      if (cb.message) {
        const confirmingGuide = await getGuideByChatId(env, cb.message.chat.id);
        if (confirmingGuide) {
          const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
          if (bookingRaw) {
            const booking = JSON.parse(bookingRaw);
            booking.assignedGuideId = confirmingGuide.id;
            await env.BOOKINGS.put(`booking:${bookingId}`, JSON.stringify(booking), { expirationTtl: 60 * 60 * 24 * 30 });
          }
        }
      }
    }

    // Answer the callback immediately too, so the guide's own Telegram
    // button stops "spinning" right away instead of waiting on the edit.
    tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: `Marked ${newStatus}` }).catch(() => {});

    const msgRefs = await getBookingMsgRefs(env, bookingId);

    // Every recipient's copy (the main group AND every guide's personal
    // DM — see recipientChatIds/sendBookingToOne above) gets the same
    // "✅ CONFIRMED"/"❌ REJECTED" badge and has its buttons cleared, so
    // whichever copy an admin acted on, every other copy reflects it too
    // — nobody can double-act on an already-settled booking from a
    // different chat.
    if (msgRefs.length && cb.message) {
      const badge = newStatus === "confirmed" ? "\u2705 CONFIRMED" : "\u274c REJECTED";
      await Promise.all(msgRefs.map((ref) => stampBookingMessage(env, ref.chatId, ref.messageId, cb, badge)));
    }

    // A rejected booking frees up that visitor's "one pending booking"
    // slot immediately, instead of waiting out the 30-day TTL — they can
    // submit a new one right away. A confirmed booking stays as their
    // on-file reference (used to look up which booking a refund request
    // is for, see handleRefundRequest below).
    if (newStatus === "cancelled") {
      const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
      const booking = bookingRaw ? JSON.parse(bookingRaw) : null;
      if (booking && booking.sessionId) {
        const pending = await env.BOOKINGS.get(`pendingbooking:${booking.sessionId}`);
        if (pending === bookingId) await env.BOOKINGS.delete(`pendingbooking:${booking.sessionId}`).catch(() => {});
      }
    }
  }

  // ---- block this booking's chat id from ever notifying here again ----
  if (action === "blockvisitor" && bookingId) {
    const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
    const booking = bookingRaw ? JSON.parse(bookingRaw) : null;
    if (!booking || !booking.sessionId) {
      tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Couldn't find who sent this booking.", show_alert: true }).catch(() => {});
      return;
    }
    const alreadyBlocked = await isSessionBlocked(env, booking.sessionId);
    if (alreadyBlocked) {
      tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Already blocked." }).catch(() => {});
    } else {
      await toggleSessionBlocked(env, booking.sessionId); // false -> true
      tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Blocked — their future bookings won't notify here.", show_alert: true }).catch(() => {});
    }
    if (cb.message) {
      await tg(env, "sendMessage", {
        chat_id: cb.message.chat.id,
        parse_mode: "HTML",
        text: `\ud83d\udeab This chat id is now blocked from booking — future submissions from them will be recorded but won't be sent here.\n<i>ref: ${escapeHtml(bookingId)}</i>`,
        reply_to_message_id: cb.message.message_id,
      }).catch(() => {});
    }
    return;
  }

  // ---- refund decision (Approve/Deny under a refund request message) ----
  if ((action === "refundok" || action === "refundno") && bookingId) {
    return handleRefundDecision(cb, env, bookingId, action === "refundok");
  }
}

// ---------------------------------------------------------------------
// REFUNDS — a visitor with a CONFIRMED booking can request a refund
// (from the site's refund-policy page). This sends a new Telegram
// message with Approve/Deny buttons, separate from the original
// booking message (which may already be long-settled), and the
// visitor's browser polls /api/refund-status/:bookingId the same way
// it already polls /api/status/:id for the original confirm/reject.
// ---------------------------------------------------------------------

// POST /api/refund-request  { sessionId, siteId, bookingId, reason }
export async function handleRefundRequest(request, env, ctx) {
  const { sessionId, siteId, bookingId, reason } = await request.json();
  if (!bookingId) return json({ ok: false, error: "bookingId is required" }, env, 400);

  const status = await getStatus(env, bookingId);
  if (status !== "confirmed") {
    return json({ ok: false, error: "Only a confirmed booking can request a refund." }, env, 400);
  }

  // Same one-at-a-time guard as bookings — no point letting someone
  // spam five refund requests for the same booking.
  const existingRefundStatus = await getRefundStatus(env, bookingId);
  if (existingRefundStatus === "requested") {
    return json({ ok: true, bookingId, refundStatus: "requested", alreadyRequested: true }, env);
  }

  const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
  const booking = bookingRaw ? JSON.parse(bookingRaw) : null;

  const text =
    `\ud83d\udcb8 <b>Refund requested — ${escapeHtml(siteId || (booking && booking.siteId) || "site")}</b>\n` +
    `<b>Booking ref:</b> ${escapeHtml(bookingId)}\n` +
    (reason ? `<b>Reason:</b> ${escapeHtml(String(reason).slice(0, 500))}\n` : "") +
    (booking && booking.data ? `\n${fmtData(booking.data)}` : "");

  const replyMarkup = {
    inline_keyboard: [[
      { text: "\u2705 Approve Refund", callback_data: `refundok:${bookingId}` },
      { text: "\u274c Deny Refund", callback_data: `refundno:${bookingId}` },
    ]],
  };

  async function send() {
    const activeElsewhere = sessionId ? await isSessionActive(env, sessionId) : false;

    // If this booking's original payment receipt is on file (it's saved
    // onto the booking record at submit time — see handleSubmit above),
    // forward it first as its own message, so whoever reviews the refund
    // has the receipt in front of them before the Approve/Deny buttons.
    // Sent as a separate message (not attached to the buttoned message
    // itself) on purpose: handleRefundDecision below edits this request
    // via editMessageText, which only works on a text message, not a
    // photo/document's caption — keeping the receipt separate means that
    // edit keeps working exactly as it already does for text-only requests.
    if (booking && booking.receipt && booking.receipt.fileId) {
      const receiptCaption = `\ud83e\uddfe <b>Payment receipt</b> — refund request for ${escapeHtml(bookingId)}`;
      const sendReceipt = booking.receipt.isImage ? tgSendPhotoByIdWithButtons : tgSendDocumentByIdWithButtons;
      await sendReceipt(env, booking.receipt.fileId, receiptCaption, undefined, activeElsewhere, env.TELEGRAM_CHAT_ID).catch(() => {});
    }

    const res = await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML", text, reply_markup: replyMarkup, disable_notification: activeElsewhere });
    if (res.ok && res.result && res.result.message_id) {
      await env.BOOKINGS.put(`refundmsg:${bookingId}`, String(res.result.message_id), { expirationTtl: 60 * 60 * 24 * 30 });
    }
    return res;
  }

  // The visitor needs to know the request actually reached the admin
  // (same correctness bar as the original booking submit), so this one
  // stays awaited rather than deferred.
  const res = await send();
  if (!res.ok) {
    return json({ ok: false, error: res.description || "telegram send failed" }, env, 502);
  }

  await setRefundStatus(env, bookingId, "requested");
  return json({ ok: true, bookingId, refundStatus: "requested" }, env);
}

// GET /api/refund-status/:bookingId
export async function handleRefundStatus(bookingId, env) {
  const status = await getRefundStatus(env, bookingId);
  return json({ bookingId, refundStatus: status }, env);
}

async function handleRefundDecision(cb, env, bookingId, approved) {
  const newStatus = approved ? "approved" : "denied";

  // Same ordering as booking confirm/reject, and same fix: this goes
  // through status-store.js (Durable Object) first, so the visitor's
  // poll picks it up instantly and reliably, regardless of how long the
  // Telegram message edit below takes.
  await setRefundStatus(env, bookingId, newStatus);

  tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: `Refund ${newStatus}` }).catch(() => {});

  const msgId = await env.BOOKINGS.get(`refundmsg:${bookingId}`);
  if (msgId && cb.message) {
    const badge = approved ? "\u2705 REFUND APPROVED" : "\u274c REFUND DENIED";
    const originalText = cb.message.text || "";
    await tg(env, "editMessageText", {
      chat_id: env.TELEGRAM_CHAT_ID,
      message_id: Number(msgId),
      parse_mode: "HTML",
      text: `${originalText}\n\n<b>${badge}</b>`,
    }).catch(() => {});
    await tg(env, "editMessageReplyMarkup", { chat_id: env.TELEGRAM_CHAT_ID, message_id: Number(msgId), reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }
}
