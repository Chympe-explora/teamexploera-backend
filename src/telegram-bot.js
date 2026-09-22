/**
 * telegram-bot.js — the whole admin experience. Everything is a button.
 * The ONLY time the admin has to type or send something is the literal
 * content itself (new text, a new number, a new photo) — never a
 * command, never a menu choice.
 *
 * Navigation model: the current "where am I" (which document, which
 * site, which path inside the JSON tree) lives in a short-lived KV
 * session, NOT in callback_data — so callback_data stays tiny (well
 * under Telegram's 64-byte limit) no matter how deep the admin has
 * drilled into the content tree.
 */

import { SCHEMA_DEFAULTS } from "./content-schema.js";
import { SITES, SITE_LABELS, getDoc, saveDoc, deepMerge, getPath, setPath, setPathSeeded, deletePath, getSession, setSession, clearSession } from "./store.js";
import { listChildren, humanize, chunk } from "./walker.js";
import { DEFAULT_DISCOUNTS } from "./pricing.js";
import { tg, tgSendMessage, tgAnswerCallbackQuery, tgSendPhotoByFileId, tgSendDocumentByFileId, tgEditMessageReplyMarkup, tgEditMessageText, kb, btn } from "./telegram.js";
import { helpButton, handleHelpCallback, smallRows } from "./help.js";
import { getLiveStats, resetStats } from "./stats.js";
import {
  GATEWAYS,
  getPaymentConfig,
  savePaymentConfig,
  setCredentialField,
  getMaskedCredentials,
  webhookUrlFor,
} from "./payments.js";
import { getEraStatusText, listUnanswered, teachAnswer, discardUnanswered, setLearningEnabled, parseQABlob, teachBulkAnswers, addAdminNotes } from "./era-ai.js";
import { getConversation, getConversationByShortId, setConversationStatus, toggleConversationActive, toggleSessionBlocked, resolveTelegramMessage, pushOutbox, statusLabel } from "./conversations.js";
import {
  SITE_PACKAGES,
  GUIDE_SITES,
  getGuides,
  getGuide,
  getGuideByChatId,
  isLinkedGuide,
  createGuide,
  regenerateGuideCode,
  redeemGuideCode,
  setGuideActive,
  setGuideBookingAccess,
  setGuidePhone,
  removeGuide as removeGuideRecord,
  getGuideBookingIds,
} from "./guides.js";
import { getAuth, isLocked, lockAccount, tryUnlock, setCustomPassword, setAdminPhone, requestGuideReset, allowGuideReset, generateGuideResetCode, redeemGuideResetCode } from "./auth.js";
import { isManualModeEnabled, setManualModeEnabled } from "./manual-mode.js";
import { sendBookingToOne } from "./booking.js";
import { isRateLimitExempt, setRateLimitExempt, clearRateLimitExempt, listRateLimitExemptions, isBlocked, adminUnblock, normalizeIp } from "./security.js";
// Same strongly-consistent status source the visitor-facing polling
// endpoints use (see status-store.js) — keeps the admin bot's view of a
// booking's status from ever disagreeing with what the visitor sees.
import { getStatus, setStatus } from "./status-store.js";
import { createReferralCode, sendReferralCard, normalizeMobile } from "./referrals.js";

// The Worker's own public URL — used to build the /media-video proxy
// link an uploaded background video is served from (see
// content-api.js's handleVideoMedia). Same domain the frontend's
// booking-bridge.js already calls for /api/*. If this project is ever
// moved to a custom domain, set a WORKER_BASE_URL env var and that
// takes priority over this fallback — see its one use below.
const DEFAULT_WORKER_BASE_URL = "https://chympe-booking-backend.book-and-explore.workers.dev";

// Media slots that can take their OWN video (in addition to the two
// whole-site video targets above: hero banner / site-wide background).
// Each entry's contentPath is a dot-path into KC_CONTENT pointing at a
// slot shaped { enabled, type, image, video, alt } (see app.js's
// MediaSlot/ImageSlot). Uploading a video here sets that slot's
// "video" field (via the same file_id → proxy-URL trick as the hero/
// background video) and flips "type" to "video" + "enabled" to true,
// so it goes live immediately — no other steps needed. Adding a new
// slot elsewhere later just means adding one line here.
const MEDIA_SLOT_VIDEO_TARGETS = {
  root: [
    { key: "exp_cave", label: "🌑 Experience — The Cave", contentPath: "imageSlots.exp_cave" },
    { key: "exp_waterfall", label: "💦 Experience — The Waterfall", contentPath: "imageSlots.exp_waterfall" },
    { key: "exp_jungle", label: "🌿 Experience — The Jungle", contentPath: "imageSlots.exp_jungle" },
    { key: "exp_homestay", label: "🏡 Experience — The Homestay", contentPath: "imageSlots.exp_homestay" },
    { key: "exp_survival", label: "🧭 Experience — Survival", contentPath: "imageSlots.exp_survival" },
    { key: "exp_water", label: "🚣 Experience — Water", contentPath: "imageSlots.exp_water" },
    { key: "exp_night", label: "🌌 Experience — Night", contentPath: "imageSlots.exp_night" },
    { key: "exp_food", label: "🍽️ Experience — Food", contentPath: "imageSlots.exp_food" },
    { key: "about_1", label: "📸 About Us — photo 1", contentPath: "imageSlots.about_1" },
    { key: "about_2", label: "📸 About Us — photo 2", contentPath: "imageSlots.about_2" },
    { key: "about_3", label: "📸 About Us — photo 3", contentPath: "imageSlots.about_3" },
    { key: "about_4", label: "📸 About Us — photo 4", contentPath: "imageSlots.about_4" },
    { key: "about_5", label: "📸 About Us — photo 5", contentPath: "imageSlots.about_5" },
    { key: "booking_1", label: "💰 Why Book Us — reason 1", contentPath: "imageSlots.booking_1" },
    { key: "booking_2", label: "📞 Why Book Us — reason 2", contentPath: "imageSlots.booking_2" },
    { key: "booking_3", label: "🌿 Why Book Us — reason 3", contentPath: "imageSlots.booking_3" },
    { key: "booking_4", label: "🔄 Why Book Us — reason 4", contentPath: "imageSlots.booking_4" },
    { key: "booking_5", label: "🤝 Why Book Us — reason 5", contentPath: "imageSlots.booking_5" },
  ],
  "krem-chympe": [
    { key: "why_1", label: "🛻 Why Visit — 01 The Journey", contentPath: "whyVisit.journeys.0.imageSlot" },
    { key: "why_2", label: "🌿 Why Visit — 02 The Trek", contentPath: "whyVisit.journeys.1.imageSlot" },
    { key: "why_3", label: "🕳️ Why Visit — 03 The Cave", contentPath: "whyVisit.journeys.2.imageSlot" },
    { key: "why_4", label: "🌊 Why Visit — 04 The Thrill", contentPath: "whyVisit.journeys.3.imageSlot" },
  ],
  "wilderness-expedition": [],
};

const CATEGORIES = [
  { kind: "content", label: "✏️ Edit Website Text", perSite: true },
  { kind: "images", label: "🖼️ Change Photos", perSite: true },
  { kind: "prices", label: "💰 Edit Prices", perSite: true, sites: ["krem-chympe", "wilderness-expedition"] },
  { kind: "discounts", label: "🏷️ Discounts & Sales", perSite: false },
  { kind: "highlights", label: "🌟 Highlights / Banner", perSite: true },
  { kind: "ratings", label: "⭐ Visitor Ratings", perSite: true },
];

export function isAdmin(env, userId) {
  const allowed = (env.ADMIN_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) return true; // no allowlist configured yet — open (see DEPLOY.md)
  return allowed.includes(String(userId));
}

// ---------------------------------------------------------------------
// GUIDE ACCESS CODES — self-service way to link a new guide's Telegram
// chat to a guide profile the admin already created (name + site +
// which packages they cover — see "➕ Add Guide" below), without
// touching ADMIN_USER_IDS / the Cloudflare dashboard. One admin creates
// the guide, shares the 6-character code, the new guide just sends
// that code as a plain message to this bot. One-time use, expires
// after 7 days.
//
// A linked guide is NOT the same as a full admin — they get their own
// separate Guide Dashboard menu (bookings assigned to them, their own
// 🟢/🔴 Active toggle, My Services, My Account), not the content-editing
// admin menu. See sendGuideMenu below, and the isAdmin/isLinkedGuide
// branch in handleTelegramAdminUpdate.
// ---------------------------------------------------------------------

// Called from handleTelegramAdminUpdate for a message from someone who
// isn't already an admin — the ONLY thing such a message is allowed to
// do is redeem a valid code. Returns true if it handled the message
// (redeemed or not, still counts as handled so the normal "you're not
// an admin" refusal doesn't also fire), false to fall through to that
// refusal as before.
async function tryRedeemGuideCode(env, chatId, userId, msg) {
  const raw = (msg.text || "").trim().toUpperCase();
  const text = raw.replace(/^\/JOIN\s+/, "");
  if (!/^[A-Z0-9]{6}$/.test(text)) return false;

  const guide = await redeemGuideCode(env, text, userId);
  if (!guide) return false; // not a real/pending code — treat as a normal (refused) message

  const packages = (SITE_PACKAGES[guide.site] || []).filter((p) => guide.services.includes("all") || guide.services.includes(p.key));
  const servicesLine = guide.services.includes("all") ? "All Services" : packages.map((p) => p.label).join(", ") || guide.services.join(", ");

  await tgSendMessage(
    env,
    chatId,
    `✅ You're linked, ${escapeHtml(guide.name)}!\n\n<b>Site:</b> ${SITE_LABELS[guide.site] || guide.site}\n<b>Services:</b> ${escapeHtml(servicesLine)}\n\nWhile you're 🟢 Active, new bookings for your services will be sent to you right here — with full details and ✅ Confirm / ❌ Reject buttons. Tap "📊 Dashboard" any time to see what's assigned to you.\n\n🔔 <b>Important:</b> keep Telegram notifications ON for this chat (check your phone's notification settings for Telegram, and that this chat isn't muted) — that's the only way you'll know the instant a new booking comes in.`
  );
  await promptGuidePhone(env, chatId);
  return true;
}

// Asked right after a new guide links (their phone is always empty at
// that point), and reachable again any time from 👤 My Account
// ("gsetphone") if they skipped it or need to change it. See the
// "guidephone" branch in handleAwaitedInput for what happens with the
// reply, and setGuidePhone in guides.js for the storage side.
async function promptGuidePhone(env, chatId) {
  await setSession(env, chatId, { awaiting: { type: "guidephone" } });
  await tgSendMessage(
    env,
    chatId,
    `📱 <b>One last step</b> — send your WhatsApp number, with country code (e.g. <code>+919876543210</code>).\n\nOnce you confirm a booking, this is what lets that visitor tap a button and message YOU directly on WhatsApp, instead of just seeing our general admin number.`,
    { reply_markup: kb([[btn("⏭ Skip For Now", "gskipphone")]]) }
  );
}

export async function handleTelegramAdminUpdate(env, update) {
  const msg = update.message;
  const cb = update.callback_query;

  const userId = msg?.from?.id ?? cb?.from?.id;
  const chatId = msg?.chat?.id ?? cb?.message?.chat?.id;
  if (!chatId) return;

  const realAdmin = isAdmin(env, userId);
  const guide = realAdmin ? null : await getGuideByChatId(env, userId);

  if (!realAdmin && !guide) {
    // Not recognized at all yet — the only thing such a message is
    // allowed to do is redeem a valid guide access code (see "➕ Add
    // Guide" in Guide Management). Anything else gets the standard
    // refusal.
    if (msg && msg.text && (await tryRedeemGuideCode(env, chatId, userId, msg))) return;
    if (msg) await tgSendMessage(env, chatId, "❌ You're not recognized by this bot yet.");
    return;
  }

  // ---------------- 🔒 PASSWORD LOCK GATE ----------------
  // Runs before absolutely anything else below, for both the real admin
  // and any linked guide. While locked, every ordinary button tap is
  // refused (as a Telegram alert, so it visibly does nothing) and the
  // only thing this account's messages are read as is a password
  // attempt — EXCEPT the guide password-recovery escape hatch just
  // below, which has to keep working even while locked, or a guide who
  // forgot their password could never get back in. See auth.js for the
  // storage/rules, and "adminlogout"/"glogout" further down for how an
  // account gets here.

  // ---- guide password-recovery bypass (never applies to admin) ----
  if (!realAdmin) {
    if (cb && cb.data === "gforgotpw") {
      await tgAnswerCallbackQuery(env, cb.id);
      return requestGuidePasswordResetFromSelf(env, chatId, guide);
    }
    if (cb && cb.data === "ghavecode") {
      await tgAnswerCallbackQuery(env, cb.id);
      return startGuideResetCodeEntry(env, chatId);
    }
    if (cb && cb.data === "gresetnow") {
      await tgAnswerCallbackQuery(env, cb.id);
      return startGuideResetNow(env, chatId);
    }
    // A guide already mid-recovery (typed "I have a code" or was told
    // to send a new password) gets their text routed there instead of
    // treated as an unlock attempt, no matter the current lock state.
    if (msg) {
      const recoverySession = await getSession(env, chatId);
      if (recoverySession?.awaiting?.type === "guideresetcode" || recoverySession?.awaiting?.type === "guideresetpw") {
        await handleAwaitedInput(env, chatId, recoverySession, msg);
        return;
      }
    }
  }

  {
    const authKind = realAdmin ? "admin" : "guide";
    const authId = realAdmin ? userId : guide.id;
    if (await isLocked(env, authKind, authId)) {
      const recoveryRows = !realAdmin ? [[btn("🔑 Forgot Password? Ask Admin", "gforgotpw")], [btn("🔑 I Have a Reset Code", "ghavecode")]] : [];
      if (cb) {
        await tgAnswerCallbackQuery(env, cb.id, "🔒 Locked — send your password in chat to unlock.", true);
        return;
      }
      if (msg && typeof msg.text === "string" && msg.text.trim()) {
        const unlocked = await tryUnlock(env, authKind, authId, msg.text);
        if (unlocked) {
          await tgSendMessage(env, chatId, "✅ Unlocked. Welcome back!");
          if (realAdmin) return sendMainMenu(env, chatId);
          const freshGuide = await getGuide(env, guide.id);
          return sendGuideMenu(env, chatId, freshGuide || guide);
        }
        await tgSendMessage(env, chatId, "🔒 <b>Wrong password.</b> Send your password to unlock, or use an option below.", recoveryRows.length ? { reply_markup: kb(recoveryRows) } : undefined);
        return;
      }
      // Any other update type (a photo, a sticker, etc.) while locked —
      // just re-ask, nothing gets processed.
      await tgSendMessage(env, chatId, "🔒 This account is locked. Send your password to unlock, or use an option below.", recoveryRows.length ? { reply_markup: kb(recoveryRows) } : undefined);
      return;
    }
  }

  // A linked guide gets an entirely separate, much smaller menu (their
  // own bookings, their own 🟢/🔴 toggle, My Services, My Account) —
  // never the content-editing admin menu. Buttons only, per spec, so
  // there's no text-input flow to handle here at all.
  if (guide && !realAdmin) {
    if (cb) {
      await tgAnswerCallbackQuery(env, cb.id);
      await handleGuideCallback(env, chatId, guide, cb.data);
      return;
    }

    // A guide can paste a visitor's booking code too (not just the
    // admin) — same lookup, same info back: which guide has it, full
    // details, and the receipt. Handy when a visitor messages a guide
    // directly with the code from their "no response yet" WhatsApp
    // fallback screen.
    if (msg?.text && BOOKING_CODE_RE.test(msg.text.trim()) && !(await getSession(env, chatId))?.awaiting) {
      return handleBookingCodeLookup(env, chatId, msg.text.trim().toLowerCase());
    }

    // Guides do have exactly one text-input flow of their own — adding
    // or editing their WhatsApp number (see promptGuidePhone / "gsetphone"
    // below) — so, unlike the rest of this branch, an awaited reply needs
    // to be routed through, not swallowed into the generic menu nudge.
    const guideSession = await getSession(env, chatId);
    if (guideSession?.awaiting) {
      await handleAwaitedInput(env, chatId, guideSession, msg);
      return;
    }

    if (msg?.text === "/start" || msg?.text === "/menu") {
      await sendGuideMenu(env, chatId, guide);
      return;
    }
    await sendGuideMenu(env, chatId, guide, "Tap a button to get started 👇");
    return;
  }

  if (cb) {
    await tgAnswerCallbackQuery(env, cb.id);
    await handleCallback(env, chatId, cb.message.message_id, cb.data, userId);
    return;
  }

  if (msg?.text === "/start" || msg?.text === "/menu") {
    await clearSession(env, chatId);
    await sendMainMenu(env, chatId);
    return;
  }

  // Jump straight into bulk-teach mode from anywhere, anytime — no
  // need to navigate the menu first.
  if (msg?.text === "/teach") {
    await startEraBulkTeach(env, chatId);
    return;
  }

  // Paste a booking code (the short id shown on a visitor's "Chat With
  // Admin" WhatsApp message after 10s of no guide response) anywhere,
  // anytime — no command needed. See handleBookingCodeLookup above.
  if (msg?.text && BOOKING_CODE_RE.test(msg.text.trim()) && !(await getSession(env, chatId))?.awaiting) {
    return handleBookingCodeLookup(env, chatId, msg.text.trim().toLowerCase());
  }

  // /reply <id> <message> — reply to a specific visitor's conversation
  // by its short ID, from anywhere, anytime (see spec §12, option 2).
  if (msg?.text && /^\/reply\b/i.test(msg.text)) {
    return handleReplyCommand(env, chatId, msg.text);
  }

  // Native Telegram "swipe to reply" on a visitor-turn message we
  // forwarded — this is an unambiguous, explicit admin gesture, so it
  // takes priority over whatever button-flow session might otherwise
  // be active (spec §12, option 3 — the preferred, easiest path for a
  // non-technical guide).
  if (msg?.text && msg.reply_to_message?.message_id) {
    const sessionId = await resolveTelegramMessage(env, msg.reply_to_message.message_id);
    if (sessionId) {
      await deliverHumanReply(env, chatId, sessionId, msg.text);
      return;
    }
  }

  // Anything else is a reply to something the bot asked for
  const session = await getSession(env, chatId);
  if (session?.awaiting) {
    await handleAwaitedInput(env, chatId, session, msg);
    return;
  }

  await sendMainMenu(env, chatId, "Tap a button to get started 👇");
}

// ---------------- MAIN MENU ----------------

async function sendMainMenu(env, chatId, note) {
  // Small buttons, 2 per row, instead of one giant column — keeps the
  // menu compact even as more categories get added later.
  const items = [
    ...CATEGORIES.map((c) => btn(c.label, `pick:${c.kind}`)),
    btn("🎬 Background", "bgpick"),
    btn("🧱 Sections", "secpick"),
    btn("🔘 Hero Button", "herobtnpick"),
    btn("📹 BG Video", "vidpick"),
    btn("🔤 Fonts & Colors", "fontpick"),
    btn("🧭 Guides", "guidemgmt"),
    btn("💳 Payment Gateway", "paypick"),
    btn("🤖 ERA AI", "eraai"),
    btn("👁️ Preview", "preview"),
    btn("📊 Stats", "stats"),
  ];
  const rows = smallRows(items, 2);
  rows.push([btn("🧨 Reset EVERYTHING to default", "resetworld")]);

  // ---- 📵 Manual WhatsApp Mode — see manual-mode.js ----
  const manualMode = await isManualModeEnabled(env);
  rows.push([btn(manualMode ? "📵 Manual WhatsApp Mode: 🟢 ON — tap to turn OFF" : "📵 Manual WhatsApp Mode: OFF — tap to turn ON", "togglemanualmode")]);

  // ---- 🔑 login & security — see auth.js ----
  const chatUserId = chatId; // admin normally messages the bot from their own personal chat, where chatId === their Telegram user id
  const adminAuth = await getAuth(env, "admin", chatUserId);
  const securityRow = [btn("🔑 Login & Security", "adminsecurity")];
  if (adminAuth && adminAuth.password) securityRow.push(btn("🔒 Log Out", "adminlogout"));
  rows.push(securityRow);

  // ---- 🚦 per-IP rate-limit on/off — see security.js ----
  rows.push([btn("🚦 Rate Limit by IP", "ratelimitmenu")]);
  rows.push([helpButton("mainmenu", "❓ Help")]);

  // Openly reminding the ADMIN of the default-password rule is fine —
  // this line must never appear on the guide-facing menu (see auth.js).
  const pwHint =
    adminAuth && adminAuth.password
      ? adminAuth.isDefault
        ? "🔑 <i>Tip: your login password defaults to your own mobile number. Tap 🔑 Login & Security to set a custom one.</i>\n\n"
        : ""
      : "🔑 <i>Set up 🔑 Login & Security below to enable 🔒 Log Out (your mobile number becomes your default password until you change it).</i>\n\n";

  const text =
    (note ? note + "\n\n" : "") +
    (manualMode
      ? "📵 <i><b>Manual WhatsApp Mode is ON</b> — new bookings post to the group only (no guide assignment), and the visitor is also sent to WhatsApp with a code. Turn this back OFF to restore normal guide assignment + live status tracking.</i>\n\n"
      : "") +
    pwHint +
    "👑 <b>Website Admin</b>\nWhat do you want to do?";
  await tgSendMessage(env, chatId, text, { reply_markup: kb(rows) });
}

async function sendAdminSecurityMenu(env, chatId, userId) {
  const auth = await getAuth(env, "admin", userId);
  const phoneLine = auth && auth.phone ? `📱 Mobile: +${escapeHtml(auth.phone)}` : "📱 Mobile: not set";
  const pwLine =
    auth && auth.password
      ? auth.isDefault
        ? "🔑 Password: default (your mobile number) — set a custom one below."
        : "🔑 Password: custom (set by you)."
      : "🔑 Password: not set yet.";
  const rows = [[btn(auth && auth.phone ? "✏️ Update Mobile Number" : "📱 Set Mobile Number", "adminsetphone")], [btn("🔑 Change Password", "adminsetpw")]];
  if (auth && auth.password) rows.push([btn("🔒 Log Out", "adminlogout")]);
  rows.push([btn("⬅️ Back", "home")]);
  await tgSendMessage(env, chatId, `🔑 <b>Login & Security</b>\n\n${phoneLine}\n${pwLine}`, { reply_markup: kb(rows) });
}

// ---------------- 🚦 PER-IP RATE LIMIT ON/OFF (see security.js) ----------------
//
// Rate limiting protects the site from malware, brute-force, and other
// scripted abuse — this menu is a narrow, deliberate escape hatch from
// it for one specific, genuine visitor's IP (e.g. a guide's office wifi
// several people book from, or a visitor whose connection keeps
// retrying). It never touches the blocklist or attack-pattern checks —
// see security.js's securityGate — and it can only be turned ON with a
// real phone number attached, so every exemption is tied to someone
// identifiable, never a bare "trust this IP forever".

async function sendRateLimitMenu(env, chatId, note) {
  const exemptions = await listRateLimitExemptions(env);
  const rows = exemptions.map((r) => [btn(`🔴 Turn rate limit back ON — ${r.ip}`, `rlclear:${r.ip}`)]);
  rows.push([btn("➕ Turn Rate Limit OFF for an IP", "rlnew")]);
  // 🔓 Separate from the exemption above: if someone (a visitor, or you
  // while testing) tripped the AUTO-BLOCK from hitting the rate limit
  // repeatedly, "can't book"/"rating shows something went wrong" is what
  // that looks like from the outside — and it's a hard 403 that happens
  // BEFORE the exemption above is ever checked, so exempting an IP after
  // the fact used to look like it "didn't work" unless you also cleared
  // the block. Turning an exemption ON now clears it automatically (see
  // setRateLimitExempt in security.js) — this button is for clearing a
  // block WITHOUT also giving that IP a standing rate-limit exemption.
  rows.push([btn("🔓 Unblock an IP", "rlunblockstart")]);
  rows.push([btn("⬅️ Back", "home")]);

  const list = exemptions.length
    ? exemptions
        .map((r) => `• <code>${escapeHtml(r.ip)}</code> — +${escapeHtml(r.phone)}${r.note ? ` (${escapeHtml(r.note)})` : ""}`)
        .join("\n")
    : "<i>No IPs are currently exempt — every visitor is rate-limited normally.</i>";

  const text =
    (note ? note + "\n\n" : "") +
    `🚦 <b>Rate Limit by IP</b>\n\n` +
    `Turning this OFF for an IP only lifts its request-count cap — the malware/brute-force/scanner defenses (blocklist + attack-pattern detection) still apply to it, and it also clears any existing block on that IP. Every exemption requires a real phone number, so it's always tied to a person you can identify, never an anonymous IP.\n\n` +
    `If a visitor says they "can't book" or their rating shows an error, that's usually an auto-block from hitting the limit, not the limit itself — use 🔓 Unblock an IP below to clear just that, without a standing exemption.\n\n` +
    `<b>Currently exempt:</b>\n${list}`;
  await tgSendMessage(env, chatId, text, { reply_markup: kb(rows) });
}

// 🔓 Standalone unblock — same IP-entry step as 🚦 Rate Limit, but only
// clears security.js's blocklist + strike count for that IP (adminUnblock),
// with no rate-limit exemption attached. Use this for a one-off "please
// let this IP back in" without vouching for it long-term.
async function sendUnblockPrompt(env, chatId) {
  await setSession(env, chatId, { awaiting: { type: "rlunblockip" } });
  await tgSendMessage(
    env,
    chatId,
    `🔓 <b>Unblock an IP</b>\n\nSend the IP address to unblock, e.g. <code>203.0.113.45</code>. This only clears an existing block — it does not exempt the IP from future rate limiting.`,
    { reply_markup: kb([[btn("❌ Cancel", "ratelimitmenu")]]) }
  );
}

// ---------------- GUIDE MANAGEMENT (admin side) ----------------

// ---------------- 💳 PAYMENT GATEWAY ----------------
// Scaffolding only — no gateway is actually wired to a live merchant
// account (see payments.js's top comment for why, and what "ready for
// later" means here). This menu is where all of that gets configured
// once a real account exists: pick a provider, paste in its
// credentials, set the currency, flip it on, and copy the webhook URL
// into that gateway's own dashboard.

async function sendPaymentSitePicker(env, chatId) {
  const rows = SITES.map((s) => [btn(SITE_LABELS[s] || s, `paysite:${s}`)]);
  rows.push([btn("⬅️ Back", "home"), helpButton("paymentgateway")]);
  await tgSendMessage(env, chatId, "💳 <b>Payment Gateway</b>\n\nWhich site?", { reply_markup: kb(rows) });
}

async function sendPaymentMenu(env, chatId, site, note) {
  const config = await getPaymentConfig(env, site);
  const gw = GATEWAYS[config.provider];
  const creds = await getMaskedCredentials(env, site);

  const lines = [
    (note ? note + "\n\n" : "") + `💳 <b>Payment Gateway — ${SITE_LABELS[site] || site}</b>`,
    `Provider: <b>${gw ? gw.label : "None selected"}</b>`,
    `Status: ${config.enabled ? "🟢 Enabled" : "🔴 Disabled"}`,
    `Currency: <b>${config.currency || "INR"}</b>`,
  ];
  if (gw && creds.length) {
    lines.push("", "<b>Credentials:</b>");
    for (const c of creds) lines.push(`${c.isSet ? "✅" : "⚪"} ${c.label}: <code>${escapeHtml(String(c.value))}</code>`);
  }

  const rows = [
    [btn("🔌 Select Gateway", `paygw:${site}`)],
  ];
  if (gw) {
    for (const f of gw.fields) {
      rows.push([btn(`🔑 Set ${f.label}`, `paycredfield:${site}:${f.key}`)]);
    }
    rows.push([btn("💱 Set Currency", `paycurrency:${site}`)]);
    rows.push([btn(config.enabled ? "🔴 Disable" : "🟢 Enable", `paytoggle:${site}`)]);
    rows.push([btn("🔔 Webhook URL", `paywebhook:${site}`)]);
  }
  rows.push([btn("⬅️ Back", "paypick"), helpButton("paymentgateway")]);

  await tgSendMessage(env, chatId, lines.join("\n"), { reply_markup: kb(rows) });
}

async function choosePaymentGateway(env, chatId, site) {
  const rows = Object.keys(GATEWAYS).map((key) => [btn(GATEWAYS[key].label, `paygwset:${site}:${key}`)]);
  rows.push([btn("🚫 None (turn off)", `paygwset:${site}:none`)]);
  rows.push([btn("⬅️ Back", `paysite:${site}`)]);
  await tgSendMessage(env, chatId, `Which gateway for ${SITE_LABELS[site] || site}?`, { reply_markup: kb(rows) });
}

async function setPaymentGateway(env, chatId, site, provider) {
  const config = await getPaymentConfig(env, site);
  config.provider = provider;
  config.enabled = false; // switching providers always requires re-enabling deliberately, never silently stays on with the old provider's credentials
  await savePaymentConfig(env, site, config);
  await sendPaymentMenu(env, chatId, site, provider === "none" ? "Gateway turned off." : `Switched to ${GATEWAYS[provider].label}. Now set its credentials below.`);
}

async function startCredentialInput(env, chatId, rest) {
  const [site, key] = rest.split(":");
  const config = await getPaymentConfig(env, site);
  const gw = GATEWAYS[config.provider];
  const field = gw && gw.fields.find((f) => f.key === key);
  if (!field) return sendPaymentMenu(env, chatId, site, "⚠️ Pick a gateway first.");
  await setSession(env, chatId, { awaiting: { type: "paymentcred", site, key } });
  await tgSendMessage(
    env,
    chatId,
    `Send the new value for <b>${escapeHtml(field.label)}</b> (${gw.label}, ${SITE_LABELS[site] || site}).\n\nIt's stored securely on the server only — never shown in full again, never sent to the website.`,
    { reply_markup: kb([[btn("❌ Cancel", `paysite:${site}`)]]) }
  );
}

async function startCurrencyInput(env, chatId, site) {
  await setSession(env, chatId, { awaiting: { type: "paymentcurrency", site } });
  await tgSendMessage(env, chatId, `Send the 3-letter currency code (e.g. INR, USD, EUR) for ${SITE_LABELS[site] || site}.`, {
    reply_markup: kb([[btn("❌ Cancel", `paysite:${site}`)]]),
  });
}

async function togglePaymentEnabled(env, chatId, site) {
  const config = await getPaymentConfig(env, site);
  config.enabled = !config.enabled;
  await savePaymentConfig(env, site, config);
  await sendPaymentMenu(env, chatId, site);
}

async function showWebhookUrl(env, chatId, site) {
  const url = webhookUrlFor(env, site);
  await tgSendMessage(
    env,
    chatId,
    `🔔 <b>Webhook URL for ${SITE_LABELS[site] || site}</b>\n\n<code>${escapeHtml(url)}</code>\n\nPaste this into your gateway's dashboard (Razorpay/Stripe/PayPal each call it something slightly different — "Webhook URL", "Endpoint URL", etc.) so it can tell this bot when a payment succeeds or fails.`,
    { reply_markup: kb([[btn("⬅️ Back", `paysite:${site}`)]]) }
  );
}

async function sendGuideManagementMenu(env, chatId, note) {
  const guides = await getGuides(env);
  const rows = [
    [btn("➕ Add Guide", "addguide"), helpButton("addguide")],
    [btn(`👥 Guides (${guides.length})`, "guidelist"), helpButton("guidemgmt")],
    [btn("⬅️ Main Menu", "home")],
  ];
  await tgSendMessage(
    env,
    chatId,
    (note ? note + "\n\n" : "") + "🧭 <b>Guide Management</b>\n\nCreate guides, assign them to Package 1 / Package 2 / Private Tour / All Services, and control who's currently eligible for new bookings.",
    { reply_markup: kb(rows) }
  );
}

async function startAddGuide(env, chatId) {
  await setSession(env, chatId, { awaiting: { type: "guidename" } });
  await tgSendMessage(env, chatId, "➕ <b>Add Guide</b>\n\nWhat's this guide's name? Send it as a plain message.", {
    reply_markup: kb([[btn("❌ Cancel", "guidemgmt"), helpButton("addguide", "❓ How It Works")]]),
  });
}

async function chooseAddGuideSite(env, chatId, site) {
  const session = await getSession(env, chatId);
  const name = session?.addGuide?.name;
  if (!name) return sendGuideManagementMenu(env, chatId, "⚠️ Let's start over.");
  await setSession(env, chatId, { addGuide: { name, site, services: [] } });
  await sendServicePicker(env, chatId, site, []);
}

async function sendServicePicker(env, chatId, site, selected) {
  const packages = SITE_PACKAGES[site] || [];
  const rows = packages.map((p) => [
    btn(`${selected.includes(p.key) ? "☑️" : "⬜"} ${p.label}`, `addguidesvc:${p.key}`),
  ]);
  rows.push([btn("✅ All Services", "addguideall")]);
  rows.push([btn(`✅ Done (${selected.length} selected)`, "addguidedone")]);
  rows.push([btn("❌ Cancel", "guidemgmt")]);
  await tgSendMessage(
    env,
    chatId,
    `📦 <b>Which services does this guide cover?</b>\n\nTap each package to toggle it, or just tap "All Services". Then tap Done.`,
    { reply_markup: kb(rows) }
  );
}

async function toggleAddGuideService(env, chatId, key) {
  const session = await getSession(env, chatId);
  const ag = session?.addGuide;
  if (!ag || !ag.site) return sendGuideManagementMenu(env, chatId, "⚠️ Let's start over.");
  const services = ag.services.includes(key) ? ag.services.filter((s) => s !== key) : [...ag.services, key];
  await setSession(env, chatId, { addGuide: { ...ag, services } });
  await sendServicePicker(env, chatId, ag.site, services);
}

async function finishAddGuide(env, chatId, allServices) {
  const session = await getSession(env, chatId);
  const ag = session?.addGuide;
  if (!ag || !ag.site) return sendGuideManagementMenu(env, chatId, "⚠️ Let's start over.");
  if (!allServices && ag.services.length === 0) {
    return sendServicePicker(env, chatId, ag.site, ag.services); // nudge them to pick at least one or tap All Services
  }
  const services = allServices ? ["all"] : ag.services;
  const { guide, code } = await createGuide(env, { name: ag.name, site: ag.site, services });
  await clearSession(env, chatId);
  await tgSendMessage(
    env,
    chatId,
    `✅ <b>${escapeHtml(guide.name)}</b> created (${SITE_LABELS[guide.site] || guide.site}).\n\n🔑 <b>Their access code:</b>\n<code>${code}</code>\n\nSend this to them. They just open a chat with this bot and send the code as a plain message — no /commands needed. Expires in 7 days, works once.`,
    { reply_markup: kb([[btn("⬅️ Guide Management", "guidemgmt")]]) }
  );
}

async function sendGuideListMenu(env, chatId, site) {
  const guides = await getGuides(env);
  if (!site) {
    // First tap: choose which site's guides to list (guides only make
    // sense per-site, since packages are per-site).
    const rows = GUIDE_SITES.map((s) => [btn(`${SITE_LABELS[s] || s} (${guides.filter((g) => g.site === s).length})`, `guidelist:${s}`)]);
    rows.push([btn("⬅️ Guide Management", "guidemgmt")]);
    await tgSendMessage(env, chatId, "👥 <b>Guides</b>\n\nWhich site?", { reply_markup: kb(rows) });
    return;
  }
  const siteGuides = guides.filter((g) => g.site === site);
  if (!siteGuides.length) {
    await tgSendMessage(env, chatId, `No guides yet for ${SITE_LABELS[site] || site}.`, {
      reply_markup: kb([[btn("➕ Add Guide", "addguide")], [btn("⬅️ Guide Management", "guidemgmt")]]),
    });
    return;
  }
  const rows = siteGuides.map((g) => {
    const status = !g.chatId ? "⏳" : g.bookingAccess === false ? "🚫" : g.active ? "🟢" : "🔴";
    return [btn(`${status} ${truncateLabel(g.name)}`, `guidedetail:${g.id}`)];
  });
  rows.push([btn("⬅️ Guide Management", "guidemgmt")]);
  await tgSendMessage(env, chatId, `👥 <b>Guides — ${SITE_LABELS[site] || site}</b>\n\n⏳ = code not redeemed yet · 🟢 Active · 🔴 Not Active · 🚫 Booking access removed`, { reply_markup: kb(rows) });
}

async function sendGuideDetailMenu(env, chatId, guideId, note) {
  const guide = await getGuide(env, guideId);
  if (!guide) return sendGuideManagementMenu(env, chatId, "⚠️ That guide no longer exists.");

  const packages = SITE_PACKAGES[guide.site] || [];
  const servicesLine = guide.services.includes("all")
    ? "All Services"
    : packages.filter((p) => guide.services.includes(p.key)).map((p) => p.label).join(", ") || "(none selected)";
  const linkLine = guide.chatId ? `Linked ✅ (chat id ${escapeHtml(String(guide.chatId))})` : `⏳ Awaiting code redemption\n<code>${escapeHtml(guide.code || "")}</code>`;

  const text =
    (note ? note + "\n\n" : "") +
    `👤 <b>${escapeHtml(guide.name)}</b>\n` +
    `Site: ${SITE_LABELS[guide.site] || guide.site}\n` +
    `Services: ${escapeHtml(servicesLine)}\n` +
    `Status: ${guide.active ? "🟢 Active" : "🔴 Not Active"} · ${guide.bookingAccess === false ? "🚫 Booking access removed" : "✅ Booking access OK"}\n` +
    `WhatsApp: ${guide.phone ? "+" + escapeHtml(guide.phone) : "⚠️ Not set yet — they'll be nudged for it from their own menu"}\n` +
    `${linkLine}`;

  const rows = [
    [btn(guide.active ? "🔴 Set Not Active" : "🟢 Set Active", `guidetoggleactive:${guide.id}`), helpButton("guidetoggleactive")],
    [btn(guide.bookingAccess === false ? "✅ Restore Access" : "🚫 Remove Access", `guidetoggleaccess:${guide.id}`), helpButton("guidetoggleaccess")],
    [btn("📋 View Bookings", `guidebookings:${guide.id}`)],
    [btn("🔑 Regenerate Code", `guideregencode:${guide.id}`), helpButton("guideregencode")],
    [btn("🔐 Generate Password Reset Code", `guideresetcodegen:${guide.id}`)],
    [btn("🗑 Remove Guide", `guideremove:${guide.id}`), helpButton("guideremove")],
    [btn("⬅️ Back", `guidelist:${guide.site}`)],
  ];
  await tgSendMessage(env, chatId, text, { reply_markup: kb(rows) });
}

// Destructive — never fire immediately (spec: confirm before anything
// that can't be trivially undone). This just shows the warning screen;
// removeGuideFromAdmin (below) does the actual delete, only reached via
// "guideremoveconfirm".
async function confirmRemoveGuide(env, chatId, guideId) {
  const guide = await getGuide(env, guideId);
  if (!guide) return sendGuideManagementMenu(env, chatId, "⚠️ That guide no longer exists.");
  const text =
    `⚠️ <b>CONFIRM ACTION</b>\n\nYou are about to permanently remove:\n\n👤 ${escapeHtml(guide.name)} — ${SITE_LABELS[guide.site] || guide.site}\n\n` +
    `This cannot be undone. Their code will stop working immediately.`;
  await tgSendMessage(env, chatId, text, {
    reply_markup: kb([
      [btn("✅ Confirm Remove", `guideremoveconfirm:${guide.id}`), btn("❌ Cancel", `guidedetail:${guide.id}`)],
    ]),
  });
}

async function toggleGuideActiveFromAdmin(env, chatId, guideId) {
  const guide = await getGuide(env, guideId);
  if (!guide) return sendGuideManagementMenu(env, chatId, "⚠️ That guide no longer exists.");
  await setGuideActive(env, guideId, !guide.active);
  await sendGuideDetailMenu(env, chatId, guideId);
}

async function toggleGuideAccessFromAdmin(env, chatId, guideId) {
  const guide = await getGuide(env, guideId);
  if (!guide) return sendGuideManagementMenu(env, chatId, "⚠️ That guide no longer exists.");
  await setGuideBookingAccess(env, guideId, guide.bookingAccess === false); // flips false->true, true/undefined->false
  await sendGuideDetailMenu(env, chatId, guideId);
}

async function regenGuideCodeFromAdmin(env, chatId, guideId) {
  const code = await regenerateGuideCode(env, guideId);
  if (!code) return sendGuideManagementMenu(env, chatId, "⚠️ That guide no longer exists.");
  await sendGuideDetailMenu(env, chatId, guideId, `🔑 New code: <code>${code}</code> (expires in 7 days, works once — their old code, if any, no longer works)`);
}

// "🔐 Generate Password Reset Code" on a guide's admin detail screen —
// a one-time, 24h code the admin reads out to the guide over a call or
// WhatsApp so they can reset their own password without needing a
// request/approval round-trip. See auth.js's generateGuideResetCode.
async function generateGuideResetCodeFromAdmin(env, chatId, guideId) {
  const guide = await getGuide(env, guideId);
  if (!guide) return sendGuideManagementMenu(env, chatId, "⚠️ That guide no longer exists.");
  const code = await generateGuideResetCode(env, guideId);
  await sendGuideDetailMenu(
    env,
    chatId,
    guideId,
    `🔐 <b>Password reset code for ${escapeHtml(guide.name)}:</b>\n<code>${code}</code>\n\nRead this out to them — they'll enter it under 🔑 I Have a Reset Code on their own dashboard. Expires in 24 hours, works once.`
  );
}

async function removeGuideFromAdmin(env, chatId, guideId) {
  const guide = await getGuide(env, guideId);
  await removeGuideRecord(env, guideId);
  await sendGuideListMenu(env, chatId, guide ? guide.site : null);
}

async function sendGuideBookingsForAdmin(env, chatId, guideId) {
  const guide = await getGuide(env, guideId);
  if (!guide) return sendGuideManagementMenu(env, chatId, "⚠️ That guide no longer exists.");
  const ids = (await getGuideBookingIds(env, guideId)).slice(-15).reverse();
  if (!ids.length) {
    await tgSendMessage(env, chatId, `${escapeHtml(guide.name)} has no bookings assigned yet.`, {
      reply_markup: kb([[btn("⬅️ Back", `guidedetail:${guideId}`)]]),
    });
    return;
  }
  const lines = await Promise.all(
    ids.map(async (id) => {
      const status = await getStatus(env, id);
      return `• <code>${escapeHtml(id)}</code> — ${escapeHtml(status)}`;
    })
  );
  await tgSendMessage(env, chatId, `📋 <b>${escapeHtml(guide.name)}'s recent bookings</b>\n\n${lines.join("\n")}`, {
    reply_markup: kb([[btn("⬅️ Back", `guidedetail:${guideId}`)]]),
  });
}

// ---------------- GUIDE DASHBOARD (the guide's own menu) ----------------

function guideStatusFooter(guide) {
  if (guide.bookingAccess === false) return "🚫 Your booking access has been removed by the admin — you can still view existing bookings.";
  return guide.active ? "🟢 You're Active — eligible for new bookings." : "🔴 You're Not Active — you won't receive new bookings until you switch back on.";
}

async function sendGuideMenu(env, chatId, guide, note) {
  const rows = [
    [btn("📊 Dashboard", "gdash"), btn("📅 Today's Bookings", "gtoday")],
    [btn("🔜 Future Bookings", "gfuture"), btn("📋 All Bookings", "gall")],
    [btn("📈 Booking Summary", "gsummary"), btn("📦 My Services", "gservices")],
    [btn(guide.active ? "🔴 Set Not Active" : "🟢 Set Active", "gtoggleactive")],
    [btn(guide.phone ? "👤 My Account" : "📱 Add WhatsApp Number", guide.phone ? "gaccount" : "gsetphone")],
  ];
  // 🔑 login & security — Log Out only shows once a password exists,
  // since logging out with no password would lock the guide out for
  // good. Never hint here that the default password is their own
  // mobile number — see auth.js's header comment.
  const guideAuth = await getAuth(env, "guide", guide.id);
  const securityRow = [btn(guideAuth && guideAuth.password ? "🔑 Change Password" : "🔑 Set Password", "gsecurity")];
  if (guideAuth && guideAuth.password) securityRow.push(btn("🔒 Log Out", "glogout"));
  rows.push(securityRow);
  // Persistent nudge until a phone number is on file — this is what a
  // confirmed visitor's WhatsApp button links to, so it matters that
  // every guide eventually sets it, without it blocking anything else.
  const phoneNudge = guide.phone
    ? ""
    : "⚠️ <b>Your WhatsApp number isn't set yet</b> — visitors won't get a direct WhatsApp button to reach you once you confirm their booking. Add it any time above.\n\n";
  await tgSendMessage(
    env,
    chatId,
    phoneNudge + (note ? note + "\n\n" : "") + `👋 <b>${escapeHtml(guide.name)}</b>\n${guideStatusFooter(guide)}`,
    { reply_markup: kb(rows) }
  );
}

async function guideBookingBuckets(env, guideId) {
  const ids = await getGuideBookingIds(env, guideId);
  const todayStr = new Date().toISOString().slice(0, 10);
  const buckets = { today: [], future: [], all: ids, completed: [], remaining: [] };
  // Fetch every id's (status, booking, completed) trio in parallel instead
  // of one id at a time — with a guide's history capped at 300 bookings,
  // a sequential loop here meant up to 300 round-trips back-to-back on
  // every dashboard tap. Results are then bucketed in `ids` order below,
  // so the output is identical regardless of which KV reads settle first.
  const perId = await Promise.all(
    ids.map(async (id) => {
      const [status, bookingRaw, completedRaw] = await Promise.all([
        getStatus(env, id),
        env.BOOKINGS.get(`booking:${id}`),
        env.BOOKINGS.get(`completed:${id}`),
      ]);
      const booking = bookingRaw ? JSON.parse(bookingRaw) : null;
      const date = booking?.data?.date || null;
      const isCompleted = completedRaw === "1";
      return { id, date, isCompleted, status };
    })
  );
  for (const { id, date, isCompleted, status } of perId) {
    if (date === todayStr) buckets.today.push(id);
    if (date && date > todayStr) buckets.future.push(id);
    if (isCompleted) buckets.completed.push(id);
    else if (status === "confirmed") buckets.remaining.push(id);
  }
  return buckets;
}

async function sendGuideBookingList(env, chatId, guide, ids, title) {
  if (!ids.length) {
    await tgSendMessage(env, chatId, `${title}\n\nNothing here right now.`, { reply_markup: kb([[btn("⬅️ Back", "gdash")]]) });
    return;
  }
  const rows = await Promise.all(
    ids.slice(-20).reverse().map(async (id) => {
      const status = await getStatus(env, id);
      return [btn(`${statusEmoji(status)} ${id}`, `gbooking:${id}`)];
    })
  );
  rows.push([btn("⬅️ Back", "gdash")]);
  await tgSendMessage(env, chatId, title, { reply_markup: kb(rows) });
}

function statusEmoji(status) {
  if (status === "confirmed") return "✅";
  if (status === "cancelled") return "❌";
  return "⏳";
}

function fmtBookingData(data) {
  return Object.entries(data || {})
    .filter(([k, v]) => v !== undefined && v !== null && v !== "" && k !== "message")
    .map(([k, v]) => `<b>${escapeHtml(k)}:</b> ${escapeHtml(String(v))}`)
    .join("\n");
}

// ---------------------------------------------------------------------
// BOOKING LOOKUP BY CODE — a visitor who gets no guide response within
// the site's 10-second countdown is shown a "Chat With Admin" WhatsApp
// button whose prefilled message includes this exact bookingId as a
// short code (see booking-bridge.js / app.js's noResponseCard on the
// frontend). The admin just pastes that code back to this bot as a
// plain message — no command needed — and gets: which guide (if any)
// it was assigned to, the full booking details, and the payment
// receipt re-sent so they can verify it themselves.
// ---------------------------------------------------------------------
const BOOKING_CODE_RE = /^[0-9a-f]{8}$/i;

async function handleBookingCodeLookup(env, chatId, bookingId) {
  const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
  if (!bookingRaw) {
    await tgSendMessage(env, chatId, `❌ No booking found for code <b>${escapeHtml(bookingId)}</b>. Double-check it with the visitor — it's the code shown on their "Chat With Admin" WhatsApp message.`);
    return;
  }
  const booking = JSON.parse(bookingRaw);

  // 📵 Manual WhatsApp Mode — this booking was submitted while the mode
  // was ON, so nothing was ever posted to Telegram for it. Pasting its
  // code is what actually posts it now: group only, with working
  // Confirm/Reject buttons and the receipt attached — same as a normal
  // submission, just triggered by hand instead of automatically. See
  // manual-mode.js.
  if (booking.pendingPost) {
    return postPendingBookingToGroup(env, chatId, bookingId, booking);
  }

  const status = await getStatus(env, bookingId);

  // Which guide(s) does this booking involve? Once someone has
  // confirmed it, assignedGuideId names them specifically. While still
  // pending, it may have been fanned out to several guides at once (see
  // booking.js#getEligibleGuides) — list all of them, since there's no
  // single "the" guide yet.
  let guideLine = "🧑\u200d🤝\u200d🧑 <b>Assigned to:</b> Admin group (no guide was assigned)";
  if (booking.assignedGuideId) {
    const guide = await getGuide(env, booking.assignedGuideId);
    guideLine = guide
      ? `🧑\u200d🤝\u200d🧑 <b>Confirmed by:</b> ${escapeHtml(guide.name)}${guide.chatId ? "" : " (not currently linked to Telegram)"}${guide.phone ? ` — +${escapeHtml(guide.phone)}` : ""}`
      : `🧑\u200d🤝\u200d🧑 <b>Confirmed by:</b> a guide who has since been removed`;
  } else if (Array.isArray(booking.eligibleGuideIds) && booking.eligibleGuideIds.length) {
    const guides = await Promise.all(booking.eligibleGuideIds.map((id) => getGuide(env, id)));
    const names = guides.filter(Boolean).map((g) => escapeHtml(g.name));
    guideLine = names.length
      ? `🧑\u200d🤝\u200d🧑 <b>Sent to:</b> ${names.join(", ")} — whoever confirms first gets it.`
      : "🧑\u200d🤝\u200d🧑 <b>Sent to:</b> guide(s) who have since been removed";
  }

  const detailsText = booking.data && booking.data.message ? escapeHtml(booking.data.message) : fmtBookingData(booking.data);

  const text =
    `🔎 <b>Booking lookup — ${escapeHtml(bookingId)}</b>\n\n` +
    `${guideLine}\n` +
    `Status: ${statusEmoji(status)} ${escapeHtml(status)}\n\n` +
    `${detailsText}`;

  // Still pending? Give the admin the same Confirm/Reject buttons every
  // guide's own copy has, right here — so a visitor stuck on the "Still
  // Waiting On Your Guide" screen can be resolved on the spot, without
  // the admin needing to go find the original message in some guide's
  // chat. This message's id is appended to the booking's tracked
  // message refs so, whichever button gets tapped (here or on a
  // guide's own copy), every copy — including this one — gets updated
  // to match, exactly like the normal multi-guide race in
  // booking.js#handleBookingCallback.
  //
  // Also shown when status is "cancelled" — i.e. every guide it was sent
  // to has declined it (see booking.js#handleBookingCallback's "all
  // eligible guides declined" fallthrough) and the visitor has been sent
  // here via the "Chat With Admin on WhatsApp" button. Tapping ✅ Confirm
  // here overrides the guides' rejection and settles it as confirmed by
  // hand (see the currentStatus === "cancelled" carve-out in
  // handleBookingCallback); ❌ Reject on an already-cancelled booking is
  // a harmless no-op ("already settled"). Never shown once "confirmed" —
  // that's final and isn't meant to be undone from here.
  const replyMarkup =
    status === "pending" || status === "cancelled"
      ? { inline_keyboard: [[{ text: "✅ Confirm", callback_data: `confirm:${bookingId}` }, { text: "❌ Reject", callback_data: `cancel:${bookingId}` }]] }
      : undefined;
  const res = await tgSendMessage(env, chatId, text, replyMarkup ? { reply_markup: replyMarkup } : undefined);
  if ((status === "pending" || status === "cancelled") && res && res.ok && res.result && res.result.message_id) {
    const msgRefsRaw = await env.BOOKINGS.get(`bookingmsg:${bookingId}`);
    let msgRefs = [];
    if (msgRefsRaw) {
      try {
        const parsed = JSON.parse(msgRefsRaw);
        msgRefs = Array.isArray(parsed) ? parsed : [{ chatId: env.TELEGRAM_CHAT_ID, messageId: parsed }];
      } catch (e) {
        msgRefs = [];
      }
    }
    msgRefs.push({ chatId, messageId: res.result.message_id });
    await env.BOOKINGS.put(`bookingmsg:${bookingId}`, JSON.stringify(msgRefs), { expirationTtl: 60 * 60 * 24 * 30 });
  }

  if (booking.receipt && booking.receipt.fileId) {
    if (booking.receipt.isImage) {
      await tgSendPhotoByFileId(env, chatId, booking.receipt.fileId, "🧾 Payment receipt for this booking");
    } else {
      await tgSendDocumentByFileId(env, chatId, booking.receipt.fileId, "🧾 Payment receipt for this booking");
    }
  } else {
    await tgSendMessage(env, chatId, "<i>No receipt was uploaded for this booking.</i>");
  }
}

// Posts a booking that was submitted while 📵 Manual WhatsApp Mode was
// ON (see manual-mode.js) — this is the moment it FIRST reaches
// Telegram, triggered by the admin pasting its code. Always goes to the
// group only (TELEGRAM_CHAT_ID) — manual mode intentionally bypasses
// per-guide assignment entirely, so there's exactly one place every such
// booking can land, no matter who pastes the code. Reuses
// sendBookingToOne from booking.js so the message looks identical to a
// normal auto-posted booking, with the same working Confirm/Reject/
// Block buttons and the receipt attached.
async function postPendingBookingToGroup(env, chatId, bookingId, booking) {
  if (!env.TELEGRAM_CHAT_ID) {
    await tgSendMessage(env, chatId, "⚠️ No TELEGRAM_CHAT_ID is configured on this Worker — there's nowhere to post this booking. Set it and try pasting the code again.");
    return;
  }

  const bodyText = booking.data && booking.data.message ? escapeHtml(booking.data.message) : fmtBookingData(booking.data);
  const text = `📵 <b>Manual booking</b> — posted via WhatsApp code\n\n${bodyText}\n\n<i>ref: ${bookingId}</i>`;
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "✅ Confirm", callback_data: `confirm:${bookingId}` },
        { text: "❌ Reject", callback_data: `cancel:${bookingId}` },
      ],
      [{ text: "🚫 Block This Chat ID From Booking", callback_data: `blockvisitor:${bookingId}` }],
    ],
  };

  const res = await sendBookingToOne(env, env.TELEGRAM_CHAT_ID, text, replyMarkup, booking.receipt, false);
  if (!res || !res.ok) {
    await tgSendMessage(env, chatId, `❌ Couldn't post this booking to the group (${(res && res.description) || "Telegram send failed"}). Nothing changed — try again.`);
    return;
  }

  // Flip it from "waiting to be posted" to "posted, pending decision" —
  // from here on it's indistinguishable from a normally-submitted
  // booking: Confirm/Reject, /api/status, and re-pasting the code (which
  // now falls through to the ordinary read-only lookup above) all work
  // exactly the same way.
  booking.pendingPost = false;
  await env.BOOKINGS.put(`booking:${bookingId}`, JSON.stringify(booking), { expirationTtl: 60 * 60 * 24 * 30 });
  await setStatus(env, bookingId, "pending");
  if (res.result && res.result.message_id) {
    await env.BOOKINGS.put(
      `bookingmsg:${bookingId}`,
      JSON.stringify([{ chatId: env.TELEGRAM_CHAT_ID, messageId: res.result.message_id }]),
      { expirationTtl: 60 * 60 * 24 * 30 }
    );
  }

  await tgSendMessage(env, chatId, `✅ Posted to the group with Confirm/Reject buttons.\n<i>ref: ${escapeHtml(bookingId)}</i>`);
}

async function sendGuideBookingDetail(env, chatId, guide, bookingId) {
  const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
  const status = await getStatus(env, bookingId);
  const completed = (await env.BOOKINGS.get(`completed:${bookingId}`)) === "1";
  if (!bookingRaw) {
    await tgSendMessage(env, chatId, "That booking's details are no longer available.", { reply_markup: kb([[btn("⬅️ Back", "gdash")]]) });
    return;
  }
  const booking = JSON.parse(bookingRaw);
  const text = `📋 <b>Booking ${escapeHtml(bookingId)}</b>\n\nStatus: ${statusEmoji(status)} ${escapeHtml(status)}${completed ? " · ✅ Completed" : ""}\n\n${fmtBookingData(booking.data)}`;
  const rows = [];
  if (status === "confirmed" && !completed) rows.push([btn("✅ Mark Completed", `gcomplete:${bookingId}`)]);
  rows.push([btn("⬅️ Back", "gdash")]);
  await tgSendMessage(env, chatId, text, { reply_markup: kb(rows) });
}

async function markGuideBookingCompleted(env, chatId, guide, bookingId) {
  await env.BOOKINGS.put(`completed:${bookingId}`, "1", { expirationTtl: 60 * 60 * 24 * 120 });
  await sendGuideBookingDetail(env, chatId, guide, bookingId);
}

async function sendGuideSummary(env, chatId, guide) {
  const buckets = await guideBookingBuckets(env, guide.id);
  const text =
    `📈 <b>Booking Summary — ${escapeHtml(guide.name)}</b>\n\n` +
    `Total assigned: <b>${buckets.all.length}</b>\n` +
    `📅 Today: <b>${buckets.today.length}</b>\n` +
    `🔜 Future: <b>${buckets.future.length}</b>\n` +
    `✅ Completed: <b>${buckets.completed.length}</b>\n` +
    `⏳ Remaining (confirmed, not yet completed): <b>${buckets.remaining.length}</b>`;
  await tgSendMessage(env, chatId, text, { reply_markup: kb([[btn("⬅️ Back", "gdash")]]) });
}

async function sendGuideServices(env, chatId, guide) {
  const packages = SITE_PACKAGES[guide.site] || [];
  const servicesLine = guide.services.includes("all")
    ? "All Services"
    : packages.filter((p) => guide.services.includes(p.key)).map((p) => p.label).join("\n") || "(none — ask admin to assign you a service)";
  await tgSendMessage(env, chatId, `📦 <b>My Services</b>\n\n${servicesLine}\n\n<i>Only the admin can change this — ask them if it needs updating.</i>`, {
    reply_markup: kb([[btn("⬅️ Back", "gdash")]]),
  });
}

async function sendGuideAccount(env, chatId, guide) {
  const text =
    `👤 <b>My Account</b>\n\n` +
    `Name: ${escapeHtml(guide.name)}\n` +
    `Site: ${SITE_LABELS[guide.site] || guide.site}\n` +
    `WhatsApp: ${guide.phone ? "+" + escapeHtml(guide.phone) : "⚠️ Not set"}\n` +
    `Linked: ${guide.linkedAt ? new Date(guide.linkedAt).toLocaleDateString() : "—"}\n` +
    `${guideStatusFooter(guide)}`;
  await tgSendMessage(env, chatId, text, {
    reply_markup: kb([[btn(guide.phone ? "✏️ Edit WhatsApp Number" : "📱 Add WhatsApp Number", "gsetphone")], [btn("⬅️ Back", "gdash")]]),
  });
}

async function startSetGuidePhone(env, chatId, guide) {
  await setSession(env, chatId, { awaiting: { type: "guidephone" } });
  await tgSendMessage(
    env,
    chatId,
    `📱 Send your WhatsApp number, with country code (e.g. <code>+919876543210</code>).`,
    { reply_markup: kb([[btn("❌ Cancel", "gaccount")]]) }
  );
}

async function sendGuideSecurityMenu(env, chatId, guide) {
  const auth = await getAuth(env, "guide", guide.id);
  const rows = [[btn(auth && auth.password ? "🔑 Change Password" : "🔑 Set Password", "gsetpw")]];
  if (auth && auth.password) rows.push([btn("🔒 Log Out", "glogout")]);
  rows.push([btn("⬅️ Back", "gdash")]);
  await tgSendMessage(env, chatId, `🔑 <b>Login & Security</b>\n\nKeep your password to yourself — you'll need it to unlock after logging out.`, { reply_markup: kb(rows) });
}

// ---------------------------------------------------------------------
// GUIDE PASSWORD RECOVERY — reachable even while locked (called directly
// from the lock-gate bypass in handleTelegramAdminUpdate, not through
// the normal handleGuideCallback dispatcher). See auth.js for storage.
// ---------------------------------------------------------------------

// "🔑 Forgot Password? Ask Admin" — sends the admin a message with this
// guide's name/details and an Allow button (see "gallowreset" in
// handleCallback for the admin side).
async function requestGuidePasswordResetFromSelf(env, chatId, guide) {
  await requestGuideReset(env, guide.id);
  const adminChatId = env.TELEGRAM_ADMIN_CHAT_ID || env.TELEGRAM_CHAT_ID;
  if (adminChatId) {
    await tgSendMessage(
      env,
      adminChatId,
      `🔑 <b>Password reset requested</b>\n\n👤 Guide: ${escapeHtml(guide.name)}\nSite: ${SITE_LABELS[guide.site] || guide.site}\nWhatsApp: ${guide.phone ? "+" + escapeHtml(guide.phone) : "not set"}`,
      { reply_markup: kb([[btn("✅ Allow Password Reset", `gallowreset:${guide.id}`)]]) }
    ).catch(() => {});
  }
  await tgSendMessage(env, chatId, "✅ Request sent to the admin. You'll get a button here to reset your password once it's approved.");
}

// "🔑 I Have a Reset Code" — a code the admin generated for this guide
// specifically and read out to them (see "guideregenresetcode" in the
// admin's guide detail screen).
async function startGuideResetCodeEntry(env, chatId) {
  await setSession(env, chatId, { awaiting: { type: "guideresetcode" } });
  await tgSendMessage(env, chatId, "🔑 Enter the reset code the admin gave you.");
}

// Reached either after an admin approves a request, or right after a
// valid reset code is entered — both land here to collect the actual
// new password.
async function startGuideResetNow(env, chatId) {
  await setSession(env, chatId, { awaiting: { type: "guideresetpw" } });
  await tgSendMessage(env, chatId, "🔑 Send your new password as plain text (at least 4 characters).");
}

async function toggleGuideActiveFromSelf(env, chatId, guide) {
  const updated = await setGuideActive(env, guide.id, !guide.active);
  await sendGuideMenu(env, chatId, updated);
}

// Dispatches every button a linked guide can tap. Kept entirely
// separate from handleCallback (the admin dispatcher) — a guide should
// never be one typo away from reaching a content-editing menu.
async function handleGuideCallback(env, chatId, guide, data) {
  const [action, rest] = [data.split(":")[0], data.split(":").slice(1).join(":")];
  // Any button tap abandons whatever text input was pending (the only
  // one that exists for guides is "guidephone") — actions that need a
  // fresh awaiting session (gsetphone) set their own right after this.
  await clearSession(env, chatId);
  const buckets = ["gdash", "gtoday", "gfuture", "gall"].includes(action) ? await guideBookingBuckets(env, guide.id) : null;

  if (action === "gdash") {
    const b = buckets;
    await tgSendMessage(
      env,
      chatId,
      `📊 <b>Dashboard</b>\n\n📅 Today: <b>${b.today.length}</b>\n🔜 Upcoming: <b>${b.future.length}</b>\n✅ Completed: <b>${b.completed.length}</b>\n⏳ Remaining: <b>${b.remaining.length}</b>`,
      { reply_markup: kb([[btn("📅 Today", "gtoday"), btn("🔜 Upcoming", "gfuture")], [btn("✅ Completed", "gcompletedlist"), btn("⏳ Remaining", "gremaining")], [btn("⬅️ Main Menu", "gmenu")]]) }
    );
    return;
  }
  if (action === "gmenu") return sendGuideMenu(env, chatId, guide);
  if (action === "gtoday") return sendGuideBookingList(env, chatId, guide, buckets.today, "📅 <b>Today's Bookings</b>");
  if (action === "gfuture") return sendGuideBookingList(env, chatId, guide, buckets.future, "🔜 <b>Future Bookings</b>");
  if (action === "gall") return sendGuideBookingList(env, chatId, guide, buckets.all, "📋 <b>All Bookings</b>");
  if (action === "gcompletedlist") {
    const b = await guideBookingBuckets(env, guide.id);
    return sendGuideBookingList(env, chatId, guide, b.completed, "✅ <b>Completed</b>");
  }
  if (action === "gremaining") {
    const b = await guideBookingBuckets(env, guide.id);
    return sendGuideBookingList(env, chatId, guide, b.remaining, "⏳ <b>Remaining</b>");
  }
  if (action === "gsummary") return sendGuideSummary(env, chatId, guide);
  if (action === "gservices") return sendGuideServices(env, chatId, guide);
  if (action === "gaccount") return sendGuideAccount(env, chatId, guide);
  if (action === "gsetphone") return startSetGuidePhone(env, chatId, guide);
  if (action === "gskipphone") return sendGuideMenu(env, chatId, guide, "⚠️ No problem — you can add your WhatsApp number any time from 👤 My Account.");
  if (action === "gtoggleactive") return toggleGuideActiveFromSelf(env, chatId, guide);
  if (action === "gbooking") return sendGuideBookingDetail(env, chatId, guide, rest);
  if (action === "gcomplete") return markGuideBookingCompleted(env, chatId, guide, rest);
  if (action === "gsecurity") return sendGuideSecurityMenu(env, chatId, guide);
  if (action === "gsetpw") {
    await setSession(env, chatId, { awaiting: { type: "guidesetpw" } });
    await tgSendMessage(env, chatId, `🔑 Send your new password as plain text (at least 4 characters).`, {
      reply_markup: kb([[btn("❌ Cancel", "gsecurity")]]),
    });
    return;
  }
  if (action === "glogout") {
    const ok = await lockAccount(env, "guide", guide.id);
    if (!ok) {
      await tgSendMessage(env, chatId, "⚠️ No password is set yet, so there's nothing to lock — set one first under 🔑 Set Password.");
      return sendGuideSecurityMenu(env, chatId, guide);
    }
    await tgSendMessage(env, chatId, "🔒 You're logged out. Every button is deactivated until you send your password here.");
    return;
  }

  await sendGuideMenu(env, chatId, guide);
}

async function sendStatsMenu(env, chatId) {
  const { visitors, bookings } = await getLiveStats(env);
  const text =
    `📊 <b>Live Stats</b>\n👀 Visitors: <b>${visitors}</b>\n✅ Confirmed bookings: <b>${bookings}</b>\n\n` +
    `This is also kept as a pinned message at the top of this chat, updating automatically as visits and confirmations come in.`;
  await tgSendMessage(env, chatId, text, {
    reply_markup: kb([[btn("🔄 Reset counters to 0", "resetstats"), helpButton("stats")], [btn("⬅️ Main Menu", "home")]]),
  });
}

// ---------------- ERA AI ----------------
// The chat assistant on the live sites. See era-ai.js for how it
// answers; everything here is just the Telegram controls for it.

async function sendEraMenu(env, chatId) {
  const status = await getEraStatusText(env);
  const text =
    `🤖 <b>ERA AI</b>\n` +
    `Learning: <b>${status.learningEnabled ? "ON 🟢" : "PAUSED 🔴"}</b>\n` +
    `Knowledge entries: <b>${status.knowledgeCount}</b>\n` +
    `Info notes fed in: <b>${status.notesCount}</b>\n` +
    `Questions waiting for an answer: <b>${status.pendingCount}</b>\n` +
    `Messages answered so far: <b>${status.totalMessages}</b>\n\n` +
    `Every new visitor chat is now a plain live chat with you by default — nothing auto-replies until you open Telegram and answer it. ` +
    `ERA AI only answers in a conversation you've explicitly switched to "🤖 AI" from that visitor's message (see the buttons under each visitor message).\n\n` +
    (status.learningEnabled
      ? "Learning is ON: whenever ERA AI is handling a conversation and can't confidently answer something, that question gets saved below so you can teach it."
      : "Learning is PAUSED: ERA AI (in any conversation you've switched it on for) keeps using what it already knows, but nothing new gets queued or auto-learned until you turn learning back on.");
  const rows = [
    [btn("📚 Bulk Teach Q&A", "erabulk")],
    [btn(status.learningEnabled ? "⏸️ Stop Learning" : "▶️ Resume Learning", "eratogglelearn")],
    [btn(`📋 Questions to Answer (${status.pendingCount})`, "erapending"), helpButton("eraai")],
    [btn("⬅️ Main Menu", "home")],
  ];
  await tgSendMessage(env, chatId, text, { reply_markup: kb(rows) });
}

// ---- Bulk Teach — paste unlimited Q&A pairs (or plain info) anytime ----
// Stays in this mode across as many messages as the admin wants to
// send, so "paste 100 Q&As" can be done in one go or spread across many
// messages, in one sitting or over days (each message refreshes the
// session so it never expires mid-feed). Tap ✅ Done (or /menu) to exit.

async function startEraBulkTeach(env, chatId) {
  await setSession(env, chatId, { kind: "eraBulk", path: [], awaiting: { type: "eraBulk" } });
  await tgSendMessage(
    env,
    chatId,
    "📚 <b>Bulk Teach Mode</b>\n\n" +
      "Paste as many questions &amp; answers as you want — in one message or spread across many, any time. Any of these styles work, and you can mix them:\n\n" +
      "<code>Q: What time is check-in?\nA: 2pm onwards.</code>\n\n" +
      "<code>1. Do you allow pets?\nNo pets allowed on site.</code>\n\n" +
      "<code>Is wifi available? -- Yes, free wifi in common areas.</code>\n\n" +
      "You can also just paste a plain paragraph of info (not shaped as Q&amp;A, e.g. forwarded from a customer chat) — I'll save it so ERA AI can search it too.\n\n" +
      "Send as many messages as you like — I'll stay in this mode. Tap ✅ Done when you're finished.",
    { reply_markup: kb([[btn("✅ Done", "eradonebulk")]]) }
  );
}

async function finishEraBulkTeach(env, chatId) {
  await clearSession(env, chatId);
  await tgSendMessage(env, chatId, "✅ Got it — thanks for teaching ERA AI!");
  return sendEraMenu(env, chatId);
}

async function toggleEraLearning(env, chatId) {
  const status = await getEraStatusText(env);
  await setLearningEnabled(env, !status.learningEnabled);
  return sendEraMenu(env, chatId);
}

async function sendEraPendingList(env, chatId) {
  const pending = await listUnanswered(env);
  if (!pending.length) {
    await tgSendMessage(env, chatId, "🎉 No pending questions — ERA AI has an answer for everything visitors have asked recently.", {
      reply_markup: kb([[btn("⬅️ Back", "eraai")]]),
    });
    return;
  }
  const rows = pending.slice(0, 15).map((q) => [btn(`${truncateLabel(q.question)} (${q.count}×)`, `eraview:${q.id}`)]);
  rows.push([btn("⬅️ Back", "eraai")]);
  await tgSendMessage(env, chatId, "📋 <b>Questions ERA AI couldn't answer</b>\nTap one to teach it the right answer.", { reply_markup: kb(rows) });
}

async function sendEraQuestionDetail(env, chatId, id) {
  const pending = await listUnanswered(env);
  const q = pending.find((p) => p.id === id);
  if (!q) return sendEraPendingList(env, chatId);
  const text = `❓ <b>Visitor asked:</b>\n"${escapeHtml(q.question)}"\n\nAsked <b>${q.count}</b> time(s) on <b>${SITE_LABELS[q.site] || q.site}</b>.`;
  await tgSendMessage(env, chatId, text, {
    reply_markup: kb([[btn("✏️ Teach the answer", `eraanswer:${id}`)], [btn("🗑️ Discard", `eradiscard:${id}`)], [btn("⬅️ Back", "erapending")]]),
  });
}

async function startEraAnswer(env, chatId, id) {
  await setSession(env, chatId, { kind: "eraTeach", path: [], awaiting: { type: "eraAnswer", questionId: id } });
  await tgSendMessage(env, chatId, "Type the answer ERA AI should give next time someone asks this ⤵️", {
    reply_markup: kb([[btn("❌ Cancel", "erapending")]]),
  });
}

async function discardEraQuestion(env, chatId, id) {
  await discardUnanswered(env, id);
  return sendEraPendingList(env, chatId);
}

// ---------------- ERA AI: per-visitor conversation control ----------------
// The hybrid human-takeover layer — see conversations.js for the store
// and forwarding, era-ai.js for what gates on conversation status.

async function startConvReply(env, chatId, sessionId) {
  const conv = await getConversation(env, sessionId);
  if (!conv) {
    await tgSendMessage(env, chatId, "⚠️ Couldn't find that visitor's conversation — it may have expired.");
    return;
  }
  await setSession(env, chatId, { kind: "convReply", path: [], awaiting: { type: "convReply", sessionId } });
  await tgSendMessage(env, chatId, `Type your reply to <b>Visitor #${conv.id}</b> ⤵️\n(You can also just swipe-reply directly on their message next time, or use <code>/reply ${conv.id} your message</code>.)`, {
    reply_markup: kb([[btn("❌ Cancel", "cancel")]]),
  });
}

async function changeConvStatus(env, chatId, sessionId, status) {
  const conv = await setConversationStatus(env, sessionId, status);
  if (!conv) {
    await tgSendMessage(env, chatId, "⚠️ Couldn't find that visitor's conversation — it may have expired.");
    return;
  }
  await tgSendMessage(env, chatId, `Visitor #${conv.id} is now <b>${statusLabel(status)}</b>.`);
}

// Flips "an admin is actively, personally handling this visitor" for
// one visitor. While active, booking.js skips sending that visitor's
// booking confirm/reject pings to the group chat (see conversations.js)
// — everything else (this chat thread, the AI/Human/Pause/Close
// controls) keeps working exactly as it does today either way.
async function toggleConvActive(env, chatId, sessionId) {
  const conv = await toggleConversationActive(env, sessionId);
  if (!conv) {
    await tgSendMessage(env, chatId, "⚠️ Couldn't find that visitor's conversation — it may have expired.");
    return;
  }
  await tgSendMessage(
    env,
    chatId,
    conv.active
      ? `🟢 Visitor #${conv.id} marked <b>Active</b> — their booking confirm/reject won't ping the group chat while this is on.`
      : `⚪ Visitor #${conv.id} marked <b>Not Active</b> — their bookings will notify the group chat as normal.`
  );
}

// Fully removes one visitor's chat id from ever generating a booking
// notification again (spam/abuse) — not just silenced like "Active"
// above, actually skipped in booking.js. Their bookings are still
// recorded in KV so nothing is lost, they just never reach Telegram.
async function toggleConvBlocked(env, chatId, sessionId) {
  const conv = await getConversation(env, sessionId);
  const nowBlocked = await toggleSessionBlocked(env, sessionId);
  const label = conv ? `Visitor #${conv.id}` : "That chat id";
  await tgSendMessage(
    env,
    chatId,
    nowBlocked
      ? `🚫 ${label} is now <b>blocked</b> — any booking they submit from now on will be recorded but won't be sent here.`
      : `✅ ${label} <b>unblocked</b> — their bookings will notify the group chat as normal again.`
  );
}

// Delivers an admin's free-form reply to a specific visitor. This is
// the one function all three reply paths (Reply button, swipe-reply,
// /reply command) funnel through. It does NOT force a takeover — per
// the hybrid spec, a guide can answer one question without pulling the
// whole conversation out of AI mode (see era-ai.js's status gating).
async function deliverHumanReply(env, chatId, sessionId, text) {
  const conv = await getConversation(env, sessionId);
  if (!conv) {
    await tgSendMessage(env, chatId, "⚠️ Couldn't find that visitor's conversation — it may have expired.");
    return;
  }
  await pushOutbox(env, sessionId, text, "human");
  await tgSendMessage(env, chatId, `✅ Sent to Visitor #${conv.id}.`);
}

async function handleReplyCommand(env, chatId, text) {
  const rest = text.replace(/^\/reply\s*/i, "").trim();
  const spaceIdx = rest.indexOf(" ");
  if (spaceIdx > 0) {
    const shortId = rest.slice(0, spaceIdx).replace(/^#/, "").trim();
    const replyText = rest.slice(spaceIdx + 1).trim();
    if (shortId && replyText) {
      const conv = await getConversationByShortId(env, shortId);
      if (!conv) {
        await tgSendMessage(env, chatId, `⚠️ No conversation found for Visitor #${shortId}.`);
        return;
      }
      await deliverHumanReply(env, chatId, conv.sessionId, replyText);
      return;
    }
  }
  await tgSendMessage(env, chatId, "Usage: <code>/reply 1047 Your message here</code>");
}

// ---------------- CALLBACK ROUTER ----------------

// Admin taps "📌 Pin to top" (or "📌 Unpin") on a rating's heads-up
// message (see the reply_markup added in ratings.js's
// handleSubmitRating). Flips that one entry's `pinned` flag in the
// same ratings:<site> doc the website reads from, then edits the
// button in place so the message reflects the new state — no
// separate confirmation needed, the button itself is the receipt.
// handleGetRatings (ratings.js) sorts pinned entries to the top of
// what visitors see, newest-pinned first, same as the rest of the
// list.
async function togglePinRating(env, chatId, messageId, site, id) {
  const docKey = `ratings:${site}`;
  const list = await getDoc(env, docKey, []);
  const arr = Array.isArray(list) ? list : [];
  const entry = arr.find((r) => r && r.id === id);
  if (!entry) {
    await tgSendMessage(env, chatId, "⚠️ Couldn't find that rating anymore — it may have been deleted.");
    return;
  }
  entry.pinned = !entry.pinned;
  await saveDoc(env, docKey, arr, {
    logChange: `${entry.pinned ? "Pinned" : "Unpinned"} a rating from ${entry.name} (${site})`,
  });

  const newLabel = entry.pinned ? "📌 Unpin" : "📌 Pin to top";
  await tgEditMessageReplyMarkup(env, chatId, messageId, {
    inline_keyboard: [[{ text: newLabel, callback_data: `pinrating:${site}:${id}` }]],
  }).catch(() => {});
}

async function handleCallback(env, chatId, messageId, data, userId) {
  const [action, ...rest] = data.split(":");

  if (action === "home") return sendMainMenu(env, chatId);

  if (action === "pinrating") {
    const [site, id] = rest;
    return togglePinRating(env, chatId, messageId, site, id);
  }

  // ---- 🔑 admin login & security ----
  if (action === "adminsecurity") return sendAdminSecurityMenu(env, chatId, userId);
  if (action === "adminsetphone") {
    await setSession(env, chatId, { awaiting: { type: "adminphone" } });
    await tgSendMessage(env, chatId, `📱 Send your mobile number, with country code (e.g. <code>+919876543210</code>).`, {
      reply_markup: kb([[btn("❌ Cancel", "adminsecurity")]]),
    });
    return;
  }
  if (action === "adminsetpw") {
    await setSession(env, chatId, { awaiting: { type: "adminsetpw" } });
    await tgSendMessage(env, chatId, `🔑 Send your new password as plain text (at least 4 characters).`, {
      reply_markup: kb([[btn("❌ Cancel", "adminsecurity")]]),
    });
    return;
  }
  // ---- 🔑 guide password-reset requests (admin side) — see
  // requestGuidePasswordResetFromSelf and the "gforgotpw" bypass in
  // handleTelegramAdminUpdate for where these requests come from ----
  if (action === "gallowreset") {
    const guideId = rest.join(":");
    const guide = await getGuide(env, guideId);
    if (!guide) {
      await tgSendMessage(env, chatId, "⚠️ That guide no longer exists.");
      return;
    }
    await allowGuideReset(env, guideId);
    await tgSendMessage(env, chatId, `✅ Approved — ${escapeHtml(guide.name)} can now reset their password.`);
    if (guide.chatId) {
      await tgSendMessage(env, guide.chatId, "✅ The admin approved your password reset request.", {
        reply_markup: kb([[btn("🔑 Reset Password Now", "gresetnow")]]),
      }).catch(() => {});
    }
    return;
  }

  if (action === "adminlogout") {
    const ok = await lockAccount(env, "admin", userId);
    if (!ok) {
      await tgSendMessage(env, chatId, "⚠️ No password is set yet, so there's nothing to lock — set one first under 🔑 Login & Security.");
      return sendAdminSecurityMenu(env, chatId, userId);
    }
    await tgSendMessage(env, chatId, "🔒 You're logged out. Every button is deactivated until you send your password here.");
    return;
  }

  if (action === "preview") return sendPreviewLinks(env, chatId);

  if (action === "togglemanualmode") {
    const nowOn = !(await isManualModeEnabled(env));
    await setManualModeEnabled(env, nowOn);
    return sendMainMenu(
      env,
      chatId,
      nowOn
        ? "📵 <b>Manual WhatsApp Mode turned ON.</b> New bookings will post straight to this group only (no guide assignment) — the visitor is also sent to WhatsApp with a code as a backup."
        : "✅ <b>Manual WhatsApp Mode turned OFF.</b> Bookings go back to normal guide assignment, and live status tracking is back on for visitors."
    );
  }

  // ---- 🚦 per-IP rate-limit on/off — see security.js ----
  if (action === "ratelimitmenu") return sendRateLimitMenu(env, chatId);

  if (action === "rlnew") {
    await setSession(env, chatId, { awaiting: { type: "rlip" } });
    await tgSendMessage(
      env,
      chatId,
      `🚦 Send the IP address to turn rate limiting OFF for (e.g. <code>203.0.113.45</code>). You can find a visitor's IP from a 🚨 Security alert message, or ask them directly.`,
      { reply_markup: kb([[btn("❌ Cancel", "ratelimitmenu")]]) }
    );
    return;
  }

  if (action === "rlclear") {
    const ip = rest.join(":");
    await clearRateLimitExempt(env, ip);
    return sendRateLimitMenu(env, chatId, `✅ Rate limiting is back ON for <code>${escapeHtml(ip)}</code>.`);
  }

  if (action === "rlunblockstart") return sendUnblockPrompt(env, chatId);

  if (action === "stats") return sendStatsMenu(env, chatId);

  if (action === "resetstats") {
    await resetStats(env);
    return sendStatsMenu(env, chatId);
  }

  // ---- ERA AI: per-visitor conversation controls (attached to every
  // forwarded visitor message — see conversations.js#convButtons) ----
  if (action === "convreply") return startConvReply(env, chatId, rest.join(":"));
  if (action === "convai") return changeConvStatus(env, chatId, rest.join(":"), "ai");
  if (action === "convtakeover") return changeConvStatus(env, chatId, rest.join(":"), "human");
  if (action === "convpause") return changeConvStatus(env, chatId, rest.join(":"), "paused");
  if (action === "convclose") return changeConvStatus(env, chatId, rest.join(":"), "closed");
  if (action === "convactive") return toggleConvActive(env, chatId, rest.join(":"));
  if (action === "convblock") return toggleConvBlocked(env, chatId, rest.join(":"));

  // ---- ERA AI ----
  if (action === "eraai") return sendEraMenu(env, chatId);
  if (action === "eratogglelearn") return toggleEraLearning(env, chatId);
  if (action === "erapending") return sendEraPendingList(env, chatId);
  if (action === "eraview") return sendEraQuestionDetail(env, chatId, rest.join(":"));
  if (action === "eraanswer") return startEraAnswer(env, chatId, rest.join(":"));
  if (action === "eradiscard") return discardEraQuestion(env, chatId, rest.join(":"));
  if (action === "erabulk") return startEraBulkTeach(env, chatId);
  if (action === "eradonebulk") return finishEraBulkTeach(env, chatId);

  if (action === "bgpick") return sendSitePicker(env, chatId, "bgshortcut", SITES);
  if (action === "secpick") return sendSitePicker(env, chatId, "secshortcut", SITES);
  if (action === "herobtnpick") return sendSitePicker(env, chatId, "herobtnshortcut", SITES);
  if (action === "vidpick") return sendSitePicker(env, chatId, "vidupload", SITES);
  if (action === "vidtarget") {
    const [site, target] = rest;
    if (target === "__back") return startVideoUpload(env, chatId, site);
    return startVideoUploadForTarget(env, chatId, site, target);
  }
  if (action === "vidslotpick") return sendMediaSlotVideoPicker(env, chatId, rest.join(":"));
  if (action === "vidslot") {
    const [site, key] = rest;
    return startVideoUploadForSlot(env, chatId, site, key);
  }

  if (action === "herobtnreset") return resetHeroButtonToDefault(env, chatId, rest.join(":"));
  if (action === "herobtnrmlink") return removeHeroButtonLink(env, chatId, rest.join(":"));
  // ---- 🔤 Fonts & Colors (heading/body size + color, per page/section) ----
  if (action === "fontpick") return sendSitePicker(env, chatId, "fontsite", SITES);
  if (action === "fontsection") {
    const [site, key] = rest;
    return sendFontFieldMenu(env, chatId, site, key);
  }
  if (action === "fontsize") {
    const [site, key, which] = rest;
    return sendFontSizePicker(env, chatId, site, key, which);
  }
  if (action === "fontcolor") {
    const [site, key, which] = rest;
    return sendFontColorPicker(env, chatId, site, key, which);
  }
  if (action === "fontsetsize") {
    const [site, key, which, ...valueParts] = rest;
    return applyFontValue(env, chatId, site, key, `${which}Size`, valueParts.join(":"));
  }
  if (action === "fontsetcolor") {
    const [site, key, which, ...valueParts] = rest;
    return applyFontValue(env, chatId, site, key, `${which}Color`, valueParts.join(":"));
  }
  if (action === "fontcustomsize") {
    const [site, key, which] = rest;
    return startFontCustomInput(env, chatId, site, key, which, "size");
  }
  if (action === "fontcustomcolor") {
    const [site, key, which] = rest;
    return startFontCustomInput(env, chatId, site, key, which, "color");
  }
  if (action === "fontresetsec") {
    const [site, key] = rest;
    return resetFontSection(env, chatId, site, key);
  }

  if (action === "guidemgmt") return sendGuideManagementMenu(env, chatId);

  if (action === "paypick") return sendPaymentSitePicker(env, chatId);
  if (action === "paysite") return sendPaymentMenu(env, chatId, rest.join(":"));
  if (action === "paygw") return choosePaymentGateway(env, chatId, rest.join(":"));
  if (action === "paygwset") {
    const [site, provider] = rest;
    return setPaymentGateway(env, chatId, site, provider);
  }
  if (action === "paycredfield") return startCredentialInput(env, chatId, rest.join(":"));
  if (action === "paycurrency") return startCurrencyInput(env, chatId, rest.join(":"));
  if (action === "paytoggle") return togglePaymentEnabled(env, chatId, rest.join(":"));
  if (action === "paywebhook") return showWebhookUrl(env, chatId, rest.join(":"));
  if (action === "addguide") return startAddGuide(env, chatId);
  if (action === "addguidesite") return chooseAddGuideSite(env, chatId, rest.join(":"));
  if (action === "addguidesvc") return toggleAddGuideService(env, chatId, rest.join(":"));
  if (action === "addguideall") return finishAddGuide(env, chatId, true);
  if (action === "addguidedone") return finishAddGuide(env, chatId, false);
  if (action === "guidelist") return sendGuideListMenu(env, chatId, rest.join(":") || null);
  if (action === "guidedetail") return sendGuideDetailMenu(env, chatId, rest.join(":"));
  if (action === "guidetoggleactive") return toggleGuideActiveFromAdmin(env, chatId, rest.join(":"));
  if (action === "guidetoggleaccess") return toggleGuideAccessFromAdmin(env, chatId, rest.join(":"));
  if (action === "guideregencode") return regenGuideCodeFromAdmin(env, chatId, rest.join(":"));
  if (action === "guideresetcodegen") return generateGuideResetCodeFromAdmin(env, chatId, rest.join(":"));
  if (action === "guideremove") return confirmRemoveGuide(env, chatId, rest.join(":"));
  if (action === "guideremoveconfirm") return removeGuideFromAdmin(env, chatId, rest.join(":"));
  if (action === "bhelp") return handleHelpCallback(env, chatId, messageId, rest.join(":"));
  if (action === "noop") return;
  if (action === "guidebookings") return sendGuideBookingsForAdmin(env, chatId, rest.join(":"));

  if (action === "pick") {
    const kind = rest[0];
    const cat = CATEGORIES.find((c) => c.kind === kind);
    if (!cat) return sendMainMenu(env, chatId);
    if (kind === "discounts") return sendDiscountsMenu(env, chatId);
    if (!cat.perSite) return openTree(env, chatId, { kind, site: null, path: [] });
    return sendSitePicker(env, chatId, kind, cat.sites || SITES);
  }

  // "bgshortcut"/"secshortcut" aren't real content kinds — they're
  // just a shorter path to two spots already inside the "content" tree
  // (KC_CONTENT.background / KC_CONTENT.sectionStyles). Translating to
  // the real kind here (rather than inventing a parallel "kind") means
  // every existing save/reset/breadcrumb function keeps working
  // unchanged, and — critically — "Reset ALL" from this shortcut still
  // means "reset all of Website Text", never a separate/smaller scope
  // that could desync from what actually renders on the site.
  const SHORTCUT_START_PATHS = { bgshortcut: ["background"], secshortcut: ["sectionStyles"], herobtnshortcut: ["hero"] };

  if (action === "site") {
    const [kind, site] = rest;
    if (kind === "fontsite") return sendFontSectionPicker(env, chatId, site);
    if (kind === "vidupload") return startVideoUpload(env, chatId, site);    const startPath = SHORTCUT_START_PATHS[kind];
    if (startPath) {
      await openTree(env, chatId, { kind: "content", site, path: [...startPath] });
      if (kind === "herobtnshortcut") {
        // A dedicated, narrowly-scoped reset — only the four hero
        // BUTTON fields (label/link/target), never the rest of hero
        // (badge/title/video/etc.) and never CONTENT.nav.items, which
        // lives at a completely different top-level key and this never
        // touches. See resetHeroButtonToDefault below.
        await tgSendMessage(env, chatId, "Just the hero button, not the nav menu:", {
          reply_markup: kb([[btn("🔄 Reset Hero Button to Default", `herobtnreset:${site}`)], [btn("🗑 Remove Link", `herobtnrmlink:${site}`)]]),
        });
      }
      return;
    }
    return openTree(env, chatId, { kind, site, path: [] });
  }

  if (action === "into") {
    const session = await getSession(env, chatId);
    if (!session) return sendMainMenu(env, chatId, "Session expired, starting over.");
    session.path.push(rest.join(":"));
    await setSession(env, chatId, session);
    return renderTree(env, chatId, session);
  }

  if (action === "up") {
    const session = await getSession(env, chatId);
    if (!session) return sendMainMenu(env, chatId);
    session.path.pop();
    await setSession(env, chatId, session);
    return renderTree(env, chatId, session);
  }

  if (action === "edit") {
    return startEdit(env, chatId, rest.join(":"));
  }

  if (action === "toggle") {
    return toggleBoolean(env, chatId, rest.join(":"));
  }

  if (action === "add") {
    return addArrayItem(env, chatId);
  }

  if (action === "moveup") {
    return moveItem(env, chatId, rest.join(":"), -1);
  }

  if (action === "movedown") {
    return moveItem(env, chatId, rest.join(":"), 1);
  }

  if (action === "del") {
    return deleteChild(env, chatId, rest.join(":"));
  }

  if (action === "resetimages") {
    return resetAllImages(env, chatId);
  }

  if (action === "resetimage") {
    return resetOneImage(env, chatId, rest.join(":"));
  }

  // ---- generic "reset to default" (content / prices / highlights /
  // discounts / ratings — images have their own version above) ----
  if (action === "resetsection") return resetSection(env, chatId);
  if (action === "resetfield") return resetOneField(env, chatId, rest.join(":"));
  if (action === "resetall") return confirmResetAll(env, chatId);
  if (action === "resetallconfirm") return resetAllForCurrentTree(env, chatId);

  // ---- the big one: wipe every override, every doc, every site ----
  if (action === "resetworld") return confirmResetEverything(env, chatId);
  if (action === "resetworldconfirm") return resetEverything(env, chatId);

  if (action === "cancel") {
    const session = await getSession(env, chatId);
    if (session && session.kind === "eraTeach") {
      await clearSession(env, chatId);
      return sendEraPendingList(env, chatId);
    }
    if (session && session.kind === "eraBulk") {
      return finishEraBulkTeach(env, chatId);
    }
    if (session && session.kind === "convReply") {
      await clearSession(env, chatId);
      await tgSendMessage(env, chatId, "Cancelled — nothing sent.");
      return;
    }
    if (session) {
      delete session.awaiting;
      await setSession(env, chatId, session);
      return renderTree(env, chatId, session, "Cancelled.");
    }
    return sendMainMenu(env, chatId);
  }

  // ---- discounts & sales shortcuts ----
  if (action === "sale") return handleSaleShortcut(env, chatId, rest);
  if (action === "salepick") return sendSalePackagePicker(env, chatId, rest[0]);
  if (action === "seasontoggle") return toggleSeasonal(env, chatId, Number(rest[0]));

  // ---- 🎁 referral card ----
  if (action === "refcard") return startReferralFlow(env, chatId);
  if (action === "refpkg") return chooseReferralPackage(env, chatId, rest[0], rest[1]);
  if (action === "refsite") return chooseReferralSite(env, chatId, rest.join(":")); // older buttons still in chat
  if (action === "refcancel") return cancelReferralFlow(env, chatId);
  if (action === "refopt") return toggleReferralPkgOption(env, chatId, messageId, rest[0]);
  if (action === "refoptdone") return finishReferralPkgOptions(env, chatId, messageId);
  if (action === "refqtynone") return skipReferralQty(env, chatId);
  if (action === "refextratoggle") return toggleReferralExtra(env, chatId, messageId, Number(rest[0]));
  if (action === "refextradone") return finishReferralExtras(env, chatId, messageId);

  return sendMainMenu(env, chatId);
}

// ---------------- SITE PICKER ----------------

async function sendSitePicker(env, chatId, kind, sites) {
  const rows = sites.map((s) => [btn(SITE_LABELS[s] || s, `site:${kind}:${s}`)]);
  rows.push([btn("⬅️ Back", "home")]);
  await tgSendMessage(env, chatId, "Which part of the website?", { reply_markup: kb(rows) });
}

// ---------------- 🔤 FONTS & COLORS ----------------
// Per-page/per-section heading & body font size + color, saved into
// the same content:<site> doc the rest of the site's text lives in
// (path: sectionStyles.<key>.typography.*) — the live site applies it
// via typography-system.js (see that file for the CSS it generates).
// A blank value just means "leave the normal styling alone", so a
// half-configured section never breaks anything.

// Which sections/pages exist per site, and a friendly label for each.
// "root" is one continuously-scrolling homepage, so its sectionStyles
// keys are named page SECTIONS. krem-chympe / wilderness-expedition
// are each a small multi-screen app, so their keys are page NUMBERS
// (see the "Page 1: Home" ... "Page 7: Refund Policy" comments in
// their app.js) — same underlying mechanism either way.
const FONT_SECTIONS = {
  root: [
    ["hero", "🎯 Hero"],
    ["destinations", "🗺️ Destinations"],
    ["experiences", "🌟 Experiences"],
    ["booking", "📋 Why Book Us"],
    ["about", "ℹ️ About"],
    ["ratings", "⭐ Ratings"],
    ["footer", "🔻 Footer"],
  ],
  "krem-chympe": [
    ["1", "🏠 Home"],
    ["2", "📦 Packages & Gallery"],
    ["3", "📝 Booking Form"],
    ["4", "💰 Pricing"],
    ["5", "💳 Payment"],
    ["6", "✅ Booking Status"],
    ["7", "↩️ Refund Policy"],
  ],
  "wilderness-expedition": [
    ["1", "🏠 Home"],
    ["2", "📦 Packages & Gallery"],
    ["3", "📝 Booking Form"],
    ["4", "💰 Pricing"],
    ["5", "💳 Payment"],
    ["6", "✅ Booking Status"],
    ["7", "↩️ Refund Policy"],
  ],
};

const FONT_SIZE_PRESETS = {
  heading: [
    ["Small", "1.5rem"],
    ["Medium", "2rem"],
    ["Large", "2.5rem"],
    ["XL", "3rem"],
  ],
  body: [
    ["Small", "0.875rem"],
    ["Medium", "1rem"],
    ["Large", "1.125rem"],
    ["XL", "1.25rem"],
  ],
};

const FONT_COLOR_PRESETS = [
  ["⚪ White", "#ffffff"],
  ["⚫ Black", "#000000"],
  ["🟢 Brand Green", "#2E8B57"],
  ["🟡 Gold", "#FFD700"],
  ["🔵 Sky", "#38BDF8"],
  ["🔴 Red", "#EF4444"],
];

const FONT_SIZE_RE = /^[0-9]{1,4}(\.[0-9]{1,3})?(px|rem|em|%)$/;
const FONT_COLOR_RE = /^(#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?|rgba?\([\d\s,.]+\)|[a-zA-Z]{3,20})$/;

function fontSectionLabel(site, key) {
  const found = (FONT_SECTIONS[site] || []).find(([k]) => k === key);
  return found ? found[1] : key;
}

async function sendFontSectionPicker(env, chatId, site) {
  const sections = FONT_SECTIONS[site] || [];
  const rows = smallRows(
    sections.map(([key, label]) => btn(label, `fontsection:${site}:${key}`)),
    2
  );
  rows.push([helpButton("fontmenu", "❓ Help"), btn("⬅️ Back", "fontpick")]);
  await tgSendMessage(env, chatId, `🔤 <b>Fonts & Colors — ${SITE_LABELS[site] || site}</b>\n\nWhich page/section?`, { reply_markup: kb(rows) });
}

async function sendFontFieldMenu(env, chatId, site, key, note) {
  const { merged } = await loadMerged(env, "content", site);
  const typo = getPath(merged, `sectionStyles.${key}.typography`) || {};
  const val = (v) => (v ? v : "<i>default</i>");
  const text =
    (note ? note + "\n\n" : "") +
    `🔤 <b>${fontSectionLabel(site, key)}</b> — ${SITE_LABELS[site] || site}\n\n` +
    `Heading size: ${val(typo.headingSize)}\n` +
    `Heading color: ${val(typo.headingColor)}\n` +
    `Body size: ${val(typo.bodySize)}\n` +
    `Body color: ${val(typo.bodyColor)}`;
  const rows = [
    [btn("🔠 Heading Size", `fontsize:${site}:${key}:heading`), helpButton("fontheadingsize")],
    [btn("🎨 Heading Color", `fontcolor:${site}:${key}:heading`), helpButton("fontheadingcolor")],
    [btn("🔡 Body Size", `fontsize:${site}:${key}:body`), helpButton("fontbodysize")],
    [btn("🎨 Body Color", `fontcolor:${site}:${key}:body`), helpButton("fontbodycolor")],
    [btn("↩️ Reset to Default", `fontresetsec:${site}:${key}`)],
    [btn("⬅️ Back", `site:fontsite:${site}`)],
  ];
  await tgSendMessage(env, chatId, text, { reply_markup: kb(rows) });
}

async function sendFontSizePicker(env, chatId, site, key, which) {
  const presets = FONT_SIZE_PRESETS[which] || FONT_SIZE_PRESETS.body;
  const rows = smallRows(
    presets.map(([label, value]) => btn(label, `fontsetsize:${site}:${key}:${which}:${value}`)),
    2
  );
  rows.push([btn("✏️ Custom Size", `fontcustomsize:${site}:${key}:${which}`)]);
  rows.push([helpButton(which === "heading" ? "fontheadingsize" : "fontbodysize", "❓ How It Works")]);
  rows.push([btn("⬅️ Back", `fontsection:${site}:${key}`)]);
  await tgSendMessage(
    env,
    chatId,
    `🔠 <b>${which === "heading" ? "Heading" : "Body"} Font Size</b>\n${fontSectionLabel(site, key)} — ${SITE_LABELS[site] || site}\n\nPick a preset, or send a custom size.`,
    { reply_markup: kb(rows) }
  );
}

async function sendFontColorPicker(env, chatId, site, key, which) {
  const rows = smallRows(
    FONT_COLOR_PRESETS.map(([label, value]) => btn(label, `fontsetcolor:${site}:${key}:${which}:${value}`)),
    2
  );
  rows.push([btn("✏️ Custom Color (hex)", `fontcustomcolor:${site}:${key}:${which}`)]);
  rows.push([helpButton(which === "heading" ? "fontheadingcolor" : "fontbodycolor", "❓ How It Works")]);
  rows.push([btn("⬅️ Back", `fontsection:${site}:${key}`)]);
  await tgSendMessage(
    env,
    chatId,
    `🎨 <b>${which === "heading" ? "Heading" : "Body"} Font Color</b>\n${fontSectionLabel(site, key)} — ${SITE_LABELS[site] || site}\n\nPick a preset, or send a custom hex color.`,
    { reply_markup: kb(rows) }
  );
}

async function applyFontValue(env, chatId, site, key, field, value) {
  const docKey = docKeyFor("content", site);
  const override = await getDoc(env, docKey, {});
  setPath(override, `sectionStyles.${key}.typography.${field}`, value);
  await saveDoc(env, docKey, override, { logChange: `Font ${field} for ${site}/${key} → ${value}` });
  await sendFontFieldMenu(env, chatId, site, key, "✅ Saved!");
}

async function startFontCustomInput(env, chatId, site, key, which, kind) {
  await setSession(env, chatId, { awaiting: { type: `font${kind}`, site, key, which } });
  const prompt =
    kind === "size"
      ? `Send a custom ${which} font size — e.g. <code>2rem</code>, <code>24px</code>, or <code>150%</code>.`
      : `Send a custom ${which} font color as a hex code — e.g. <code>#38bdf8</code>.`;
  await tgSendMessage(env, chatId, prompt, {
    reply_markup: kb([[btn("❌ Cancel", `font${kind}:${site}:${key}:${which}`)]]),
  });
}

async function resetFontSection(env, chatId, site, key) {
  const docKey = docKeyFor("content", site);
  const override = await getDoc(env, docKey, {});
  setPath(override, `sectionStyles.${key}.typography`, { headingSize: "", headingColor: "", bodySize: "", bodyColor: "" });
  await saveDoc(env, docKey, override, { logChange: `Reset fonts for ${site}/${key}` });
  await sendFontFieldMenu(env, chatId, site, key, "↩️ Reset to default styling.");
}

async function sendPreviewLinks(env, chatId) {
  const base = env.SITE_BASE_URL || "https://your-site.example.com";
  const text =
    `👁️ <b>Live site links</b>\n\n` +
    `🏠 <a href="${base}/">Home</a>\n` +
    `🌊 <a href="${base}/krem-chympe/">Krem Chympe</a>\n` +
    `🥾 <a href="${base}/wilderness-expedition/">Wilderness Expedition</a>\n\n` +
    `Changes usually appear within a few seconds of saving.`;
  await tgSendMessage(env, chatId, text, { reply_markup: kb([[btn("⬅️ Main Menu", "home")]]) });
}

// ---------------- TREE NAVIGATION (generic — works for content, images, prices, highlights, discounts) ----------------

function defaultsFor(kind, site) {
  if (kind === "discounts") return DEFAULT_DISCOUNTS;
  if (kind === "highlights") return [];
  if (kind === "ratings") return [];
  const schema = SCHEMA_DEFAULTS[site];
  if (!schema) return {};
  if (kind === "content") return schema.KC_CONTENT || {};
  if (kind === "images") return schema.KC_IMAGES || {};
  if (kind === "prices") return schema.KC_PRICES || {};
  return {};
}

function docKeyFor(kind, site) {
  return kind === "discounts" ? "discounts:global" : `${kind}:${site}`;
}

async function loadMerged(env, kind, site) {
  const docKey = docKeyFor(kind, site);
  const base = defaultsFor(kind, site);
  const override = await getDoc(env, docKey, Array.isArray(base) ? [] : {});
  return { docKey, merged: deepMerge(base, override) };
}

async function openTree(env, chatId, session) {
  await setSession(env, chatId, session);
  return renderTree(env, chatId, session);
}

async function renderTree(env, chatId, session, note) {
  const { merged } = await loadMerged(env, session.kind, session.site);
  const currentPath = session.path.join(".");
  const node = currentPath ? getPath(merged, currentPath) : merged;
  const children = listChildren(node);

  const catLabel = CATEGORIES.find((c) => c.kind === session.kind)?.label || session.kind;
  const crumbs = [SITE_LABELS[session.site] || null, ...session.path.map(humanize)].filter(Boolean).join(" › ") || "Top level";

  const rows = [];
  for (const group of chunk(children, 1)) {
    for (const child of group) {
      // Booleans get a single tap-to-flip toggle button instead of a
      // "type true/false" text prompt — this is what makes things like
      // "Hero Video: On/Off" or "Notice: On/Off" a real on/off switch
      // in the bot, with no typing required.
      if (child.kind === "boolean") {
        const isOnVal = child.preview === "true";
        const label = `${isOnVal ? "✅" : "⛔"} ${humanize(child.key)} — ${isOnVal ? "ON (tap to turn off)" : "OFF (tap to turn on)"}`;
        rows.push([btn(truncateLabel(label), `toggle:${child.key}`)]);
        continue;
      }
      const label = `${iconFor(child.kind, session.kind)} ${humanize(child.key)} — ${child.preview}`;
      const cb = child.kind === "object" || child.kind === "array" ? `into:${child.key}` : `edit:${child.key}`;
      const row = [btn(truncateLabel(label), cb)];
      // Reordering: only offered for items that live directly inside an
      // array (nav items, highlights, meals, ...) — not for object
      // fields. First item has no "up", last has no "down".
      if (Array.isArray(node)) {
        const idx = Number(child.key);
        if (idx > 0) row.push(btn("⬆️", `moveup:${child.key}`));
        if (idx < node.length - 1) row.push(btn("⬇️", `movedown:${child.key}`));
      }
      rows.push(row);
    }
  }

  if (Array.isArray(node)) {
    rows.push([btn("➕ Add new item", "add")]);
  }
  if (session.kind === "images" && session.path.length === 0) {
    rows.push([btn("🔄 Reset ALL photos to default", "resetimages")]);
  }
  // Every non-image section gets the same two reset options images
  // already had: reset just what you're looking at right now, or reset
  // the whole category (this site's text / highlights / ratings /
  // prices, or the global discounts) back to what's baked into the
  // code. This is also the fix if a section ever gets emptied out by
  // accident (like Destinations did) — open it and tap Reset.
  if (session.kind !== "images" && session.path.length > 0) {
    rows.push([btn("↩️ Reset this section to default", "resetsection")]);
  }
  if (session.kind !== "images" && session.path.length === 0) {
    rows.push([btn(`🔄 Reset ALL ${catLabel.replace(/^[^\s]+\s/, "")} to default`, "resetall")]);
  }
  if (session.path.length && Array.isArray(getPath(merged, session.path.slice(0, -1).join(".")) ?? merged)) {
    // current node is an item inside an array one level up — offer delete
    rows.push([btn("🗑️ Delete this item", `del:${session.path[session.path.length - 1]}:__self`)]);
  }

  const navRow = [];
  if (session.path.length) navRow.push(btn("⬆️ Up", "up"));
  navRow.push(btn("🏠 Main Menu", "home"));
  rows.push(navRow);

  const text = (note ? note + "\n\n" : "") + `<b>${catLabel}</b>\n📍 ${crumbs}\n\nTap to open, or tap a field to edit it.`;
  await tgSendMessage(env, chatId, text, { reply_markup: kb(rows) });
}

function iconFor(childKind, docKind) {
  if (docKind === "images") return "🖼️";
  if (childKind === "object") return "📁";
  if (childKind === "array") return "📋";
  if (childKind === "number") return "🔢";
  return "✏️";
}

function truncateLabel(s) {
  return s.length > 60 ? s.slice(0, 59) + "…" : s;
}

// ---------------- TOGGLE A BOOLEAN (on/off switches, e.g. hero video, notice) ----------------

async function toggleBoolean(env, chatId, key) {
  const session = await getSession(env, chatId);
  if (!session) return sendMainMenu(env, chatId, "Session expired, starting over.");
  const { docKey, merged } = await loadMerged(env, session.kind, session.site);
  const path = [...session.path, key].join(".");
  const current = getPath(merged, path);
  const next = !(current === true || current === "true");

  const base = defaultsFor(session.kind, session.site);
  const override = await getDoc(env, docKey, Array.isArray(base) ? [] : {});
  setPathSeeded(override, merged, path, next);
  await saveDoc(env, docKey, override, { logChange: `Changed ${path} → ${next}` });

  return renderTree(env, chatId, session, `${next ? "✅ Turned ON" : "⛔ Turned OFF"}: ${humanize(key)}`);
}

// ---------------- EDIT A LEAF ----------------

// Starts the "upload a background video from your phone" flow — a
// dedicated one-off session (not tied to the generic content tree),
// since a video upload isn't editing one leaf value, it's replacing a
// whole file and re-pointing background.global.videoUrl at it.
// Resets ONLY the hero button's four fields (label, link, and whichever
// target field this site uses) back to schema defaults — deletes them
// from the content override doc entirely so they fall back to
// content-schema.js's defaults naturally, same as any other field reset
// to default. Never touches the rest of `hero` (badge/title/video/etc)
// and never touches CONTENT.nav.items, which lives at a completely
// separate top-level key this function never reads or writes.
async function resetHeroButtonToDefault(env, chatId, site) {
  const override = await getDoc(env, `content:${site}`, {});
  const HERO_BUTTON_KEYS = ["hero.bookNowLabel", "hero.bookNowLink", "hero.bookNowTargetId", "hero.bookNowTargetPage"];
  for (const path of HERO_BUTTON_KEYS) deletePath(override, path);
  await saveDoc(env, `content:${site}`, override, { logChange: "Hero button reset to default" });
  await tgSendMessage(
    env,
    chatId,
    `✅ Hero button reset to default on ${SITE_LABELS[site] || site} — label, link, and destination are all back to the site's original values. Nothing else (including the nav menu) was touched.`,
    { reply_markup: kb([[btn("🔘 Hero Button (text & link)", "herobtnpick")], [btn("⬅️ Main Menu", "home")]]) }
  );
}

// Narrower than the full reset above — clears ONLY the link override,
// leaving the button's label and normal scroll/page destination
// exactly as they are. This is what turns the button back to "just
// scrolls/switches page like normal" without also resetting its text.
async function removeHeroButtonLink(env, chatId, site) {
  const override = await getDoc(env, `content:${site}`, {});
  deletePath(override, "hero.bookNowLink");
  await saveDoc(env, `content:${site}`, override, { logChange: "Hero button link removed" });
  await tgSendMessage(
    env,
    chatId,
    `✅ Link removed from the hero button on ${SITE_LABELS[site] || site} — it now scrolls/switches page like normal again. Label and destination page are unchanged.`,
    { reply_markup: kb([[btn("🔘 Hero Button (text & link)", "herobtnpick")], [btn("⬅️ Main Menu", "home")]]) }
  );
}

// A hero video upload can target either of two different things, and
// it matters which:
//   - "background": the site-wide FIXED video behind the whole page
//     (background.global.videoUrl — see background-system.js), visible
//     on every section, not just the hero banner.
//   - "hero": the Hero banner's OWN video (hero.videoUrl), the one that
//     plays specifically inside the top hero section, independent of
//     whatever the site-wide background is doing.
// Both live on all 3 sites' hero sections — this lets an admin update
// either one straight from Telegram, no code/redeploy needed either way.
async function startVideoUpload(env, chatId, site) {
  const slots = MEDIA_SLOT_VIDEO_TARGETS[site] || [];
  const rows = [
    [btn("🌐 Site-wide Background Video", `vidtarget:${site}:background`)],
    [btn("🎭 Hero Banner Video", `vidtarget:${site}:hero`)],
  ];
  if (slots.length) rows.push([btn("🎞️ A Section/Slot's Own Video", `vidslotpick:${site}`)]);
  rows.push([btn("❌ Cancel", "cancel")]);
  await tgSendMessage(env, chatId, `🎬 <b>${SITE_LABELS[site] || site}</b> — which video?`, { reply_markup: kb(rows) });
}

// Lists every media slot on this site that can take its own video (see
// MEDIA_SLOT_VIDEO_TARGETS above) so the admin can pick exactly which
// section/card the new clip belongs to.
async function sendMediaSlotVideoPicker(env, chatId, site) {
  const slots = MEDIA_SLOT_VIDEO_TARGETS[site] || [];
  if (!slots.length) {
    await tgSendMessage(env, chatId, "No slot videos are set up for this site yet.", {
      reply_markup: kb([[btn("⬅️ Back", `vidtarget:${site}:__back`)], [btn("❌ Cancel", "cancel")]]),
    });
    return;
  }
  const rows = slots.map((s) => [btn(s.label, `vidslot:${site}:${s.key}`)]);
  rows.push([btn("❌ Cancel", "cancel")]);
  await tgSendMessage(
    env,
    chatId,
    `🎞️ <b>${SITE_LABELS[site] || site}</b> — pick which section's photo slot gets a video instead. It'll show with a play button, tap-to-play with sound, right where that photo/card is now.`,
    { reply_markup: kb(rows) }
  );
}

async function startVideoUploadForSlot(env, chatId, site, key) {
  const slot = (MEDIA_SLOT_VIDEO_TARGETS[site] || []).find((s) => s.key === key);
  if (!slot) return sendMainMenu(env, chatId, "That slot isn't available anymore.");
  await setSession(env, chatId, { awaiting: { type: "video", site, target: "slot", slotKey: key, contentPath: slot.contentPath } });
  await tgSendMessage(
    env,
    chatId,
    `🎬 <b>New video — ${slot.label}</b>\n\nSend the video now, right here in this chat (as a normal video message, not a document). It'll show in place of that photo, with a play button, and go live immediately.\n\n<i>Telegram caps bot uploads at 50MB — if yours is bigger, compress it first.</i>`,
    { reply_markup: kb([[btn("❌ Cancel", "cancel")]]) }
  );
}

async function startVideoUploadForTarget(env, chatId, site, target) {
  await setSession(env, chatId, { awaiting: { type: "video", site, target } });
  const targetLabel = target === "hero" ? "the Hero banner's own video" : "the site-wide fixed background video";
  await tgSendMessage(
    env,
    chatId,
    `🎬 <b>New video — ${SITE_LABELS[site] || site}</b>\n\nSend the video now, right here in this chat (as a normal video message, not a document). It'll replace ${targetLabel} and go live immediately — no other steps needed.\n\n<i>Telegram caps bot uploads at 50MB — if yours is bigger, compress it first.</i>`,
    { reply_markup: kb([[btn("❌ Cancel", "cancel")]]) }
  );
}

async function startEdit(env, chatId, key) {
  const session = await getSession(env, chatId);
  if (!session) return sendMainMenu(env, chatId, "Session expired, starting over.");
  const { merged } = await loadMerged(env, session.kind, session.site);
  const path = [...session.path, key].join(".");
  const current = getPath(merged, path);

  if (session.kind === "images") {
    session.awaiting = { path, type: "photo" };
    await setSession(env, chatId, session);
    await tgSendMessage(env, chatId, `📸 Send the new photo for <b>${humanize(key)}</b>.\n(Just send it as a normal photo message.)`, {
      reply_markup: kb([[btn("↩️ Reset this one to default", `resetimage:${key}`)], [btn("❌ Cancel", "cancel")]]),
    });
    return;
  }

  const type = typeof current === "number" ? "number" : "text";
  session.awaiting = { path, type };
  await setSession(env, chatId, session);
  // Every field-edit prompt gets its own "Reset to Default" button too —
  // not just the section/category/whole-site resets further up the
  // tree — so a single field can be put back to its shipped default
  // without having to reset (and lose edits to) everything else that
  // lives alongside it in the same section.
  await tgSendMessage(
    env,
    chatId,
    `✏️ <b>${humanize(key)}</b>\nCurrent value:\n<code>${escapeHtml(String(current ?? ""))}</code>\n\nReply with the new ${type === "number" ? "number" : "text"}.`,
    { reply_markup: kb([[btn("↩️ Reset to Default", `resetfield:${key}`)], [btn("❌ Cancel", "cancel")]]) }
  );
}

// Resets ONLY the single field currently being edited (or that was just
// tapped) back to its schema default — deletes it from the override doc
// so it falls back to content-schema.js's default, same mechanism as
// resetSection/resetOneImage below, just scoped one level deeper (path
// + this one key, not the whole section).
async function resetOneField(env, chatId, key) {
  const session = await getSession(env, chatId);
  if (!session) return sendMainMenu(env, chatId, "Session expired, starting over.");
  const docKey = docKeyFor(session.kind, session.site);
  const base = defaultsFor(session.kind, session.site);
  const override = await getDoc(env, docKey, Array.isArray(base) ? [] : {});
  const path = [...session.path, key].join(".");
  deletePath(override, path);
  await saveDoc(env, docKey, override, { logChange: `Reset "${path}" to default` });
  delete session.awaiting;
  await setSession(env, chatId, session);
  return renderTree(env, chatId, session, `↩️ ${humanize(key)} reset to default.`);
}

async function handleAwaitedInput(env, chatId, session, msg) {
  const { awaiting } = session;

  if (
    awaiting.type === "refPackage" || awaiting.type === "refName" || awaiting.type === "refPeople" ||
    awaiting.type === "refMobile" || awaiting.type === "refPkgOptions" || awaiting.type === "refQty" ||
    awaiting.type === "refExtrasChoice" || awaiting.type === "refDiscount"
  ) {
    return handleReferralAwaitedInput(env, chatId, session, msg, awaiting.type);
  }

  if (awaiting.type === "eraBulk") {
    const text = (msg.text ?? "").trim();
    if (!text) {
      await tgSendMessage(env, chatId, "Paste some Q&A text (or plain info), or tap ✅ Done to finish.", {
        reply_markup: kb([[btn("✅ Done", "eradonebulk")]]),
      });
      return;
    }
    const { pairs, notes } = parseQABlob(text);
    const addedPairs = await teachBulkAnswers(env, pairs);
    const addedNotes = await addAdminNotes(env, notes);
    await setSession(env, chatId, session); // refresh the session TTL — stay in bulk mode for the next paste

    const parts = [];
    if (addedPairs) parts.push(`✅ Learned ${addedPairs} Q&amp;A pair${addedPairs === 1 ? "" : "s"}.`);
    if (addedNotes) parts.push(`📝 Saved ${addedNotes} info note${addedNotes === 1 ? "" : "s"} for ERA AI to search.`);
    if (!parts.length) parts.push("Hmm, I couldn't find any Q&amp;A or info in that — try again, or check the format examples above.");

    await tgSendMessage(env, chatId, parts.join("\n") + "\n\nKeep pasting more any time, or tap ✅ Done when finished.", {
      reply_markup: kb([[btn("✅ Done", "eradonebulk")]]),
    });
    return;
  }

  if (awaiting.type === "convReply") {
    const text = (msg.text ?? "").trim();
    if (!text) {
      await tgSendMessage(env, chatId, "Please type your reply, or tap Cancel.", { reply_markup: kb([[btn("❌ Cancel", "cancel")]]) });
      return;
    }
    await deliverHumanReply(env, chatId, awaiting.sessionId, text);
    await clearSession(env, chatId);
    return;
  }

  if (awaiting.type === "eraAnswer") {
    const text = (msg.text ?? "").trim();
    if (!text) {
      await tgSendMessage(env, chatId, "Please type an answer, or tap Cancel.", { reply_markup: kb([[btn("❌ Cancel", "erapending")]]) });
      return;
    }
    await teachAnswer(env, awaiting.questionId, text);
    await clearSession(env, chatId);
    await tgSendMessage(env, chatId, "✅ ERA AI learned that answer! It'll use it next time this question comes up.", {
      reply_markup: kb([[btn("⬅️ Back to ERA AI", "eraai")]]),
    });
    return;
  }

  if (awaiting.type === "fontsize" || awaiting.type === "fontcolor") {
    const text = (msg.text ?? "").trim();
    const { site, key, which } = awaiting;
    const isSize = awaiting.type === "fontsize";
    const re = isSize ? FONT_SIZE_RE : FONT_COLOR_RE;
    if (!re.test(text)) {
      await tgSendMessage(
        env,
        chatId,
        isSize
          ? `That doesn't look like a valid size. Use a number plus a unit — e.g. <code>2rem</code>, <code>24px</code>, <code>150%</code>. Try again, or tap Cancel.`
          : `That doesn't look like a valid color. Use a hex code — e.g. <code>#38bdf8</code>. Try again, or tap Cancel.`,
        { reply_markup: kb([[btn("❌ Cancel", `font${isSize ? "size" : "color"}:${site}:${key}:${which}`)]]) }
      );
      return;
    }
    await clearSession(env, chatId);
    return applyFontValue(env, chatId, site, key, `${which}${isSize ? "Size" : "Color"}`, text);
  }

  if (awaiting.type === "paymentcred") {
    const value = (msg.text ?? "").trim();
    if (!value) {
      await tgSendMessage(env, chatId, "Please send the value as plain text, or tap Cancel.", { reply_markup: kb([[btn("❌ Cancel", `paysite:${awaiting.site}`)]]) });
      return;
    }
    await setCredentialField(env, awaiting.site, awaiting.key, value);
    await clearSession(env, chatId);
    await sendPaymentMenu(env, chatId, awaiting.site, "✅ Saved.");
    return;
  }

  if (awaiting.type === "paymentcurrency") {
    const code = (msg.text ?? "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) {
      await tgSendMessage(env, chatId, "That doesn't look like a 3-letter currency code (e.g. INR, USD). Try again, or tap Cancel.", {
        reply_markup: kb([[btn("❌ Cancel", `paysite:${awaiting.site}`)]]),
      });
      return;
    }
    const config = await getPaymentConfig(env, awaiting.site);
    config.currency = code;
    await savePaymentConfig(env, awaiting.site, config);
    await clearSession(env, chatId);
    await sendPaymentMenu(env, chatId, awaiting.site, "✅ Saved.");
    return;
  }

  if (awaiting.type === "guidename") {
    const name = (msg.text ?? "").trim();
    if (!name) {
      await tgSendMessage(env, chatId, "Please send a name as plain text, or tap Cancel.", { reply_markup: kb([[btn("❌ Cancel", "guidemgmt")]]) });
      return;
    }
    await setSession(env, chatId, { addGuide: { name } });
    const rows = GUIDE_SITES.map((s) => [btn(SITE_LABELS[s] || s, `addguidesite:${s}`)]);
    rows.push([btn("❌ Cancel", "guidemgmt")]);
    await tgSendMessage(env, chatId, `Which site is <b>${escapeHtml(name)}</b> a guide for?`, { reply_markup: kb(rows) });
    return;
  }

  if (awaiting.type === "guidephone") {
    const raw = (msg.text ?? "").trim();
    const guide = await getGuideByChatId(env, chatId);
    if (!guide) {
      await clearSession(env, chatId);
      return; // no longer a linked guide somehow — nothing to save this to
    }
    if (/^(skip|later|no|none)$/i.test(raw)) {
      await clearSession(env, chatId);
      await sendGuideMenu(env, chatId, guide, "⚠️ No problem — you can add your WhatsApp number any time from 👤 My Account.");
      return;
    }
    // wa.me links take digits only (no "+", spaces, or dashes) — accept
    // whatever the guide sends and strip everything but the digits and a
    // leading "+" for validation, then drop the "+" for storage.
    const cleaned = raw.replace(/[^\d+]/g, "");
    if (!/^\+?\d{7,15}$/.test(cleaned)) {
      await tgSendMessage(
        env,
        chatId,
        `That doesn't look like a valid number. Send it with your country code, e.g. <code>+919876543210</code> — or tap Skip to add it later.`,
        { reply_markup: kb([[btn("⏭ Skip For Now", "gskipphone")]]) }
      );
      return;
    }
    const phone = cleaned.replace(/^\+/, "");
    await setGuidePhone(env, guide.id, phone);
    await clearSession(env, chatId);
    await tgSendMessage(env, chatId, `✅ Saved! Once you confirm a booking, the visitor will see a button to message you directly at +${escapeHtml(phone)} on WhatsApp.`);
    const updated = await getGuide(env, guide.id);
    await sendGuideMenu(env, chatId, updated);
    return;
  }

  // ---- 🚦 per-IP rate-limit on/off — see security.js ----
  if (awaiting.type === "rlip") {
    const ip = (msg.text ?? "").trim();
    // Loose IPv4/IPv6 shape check — good enough to catch typos without
    // rejecting anything Cloudflare's cf-connecting-ip header could
    // actually send.
    if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) {
      await tgSendMessage(env, chatId, `That doesn't look like a valid IP address. Send just the address, e.g. <code>203.0.113.45</code>, or tap Cancel.`, {
        reply_markup: kb([[btn("❌ Cancel", "ratelimitmenu")]]),
      });
      return;
    }
    await setSession(env, chatId, { awaiting: { type: "rlphone", ip } });
    await tgSendMessage(
      env,
      chatId,
      `📱 Now send the phone number of the person behind <code>${escapeHtml(ip)}</code> (with country code, e.g. <code>+919876543210</code>) — this is what ties the exemption to a real, identifiable visitor.`,
      { reply_markup: kb([[btn("❌ Cancel", "ratelimitmenu")]]) }
    );
    return;
  }

  if (awaiting.type === "rlphone") {
    const raw = (msg.text ?? "").trim();
    const cleaned = raw.replace(/[^\d+]/g, "");
    if (!/^\+?\d{7,15}$/.test(cleaned)) {
      await tgSendMessage(env, chatId, `That doesn't look like a valid number. Send it with country code, e.g. <code>+919876543210</code>, or tap Cancel.`, {
        reply_markup: kb([[btn("❌ Cancel", "ratelimitmenu")]]),
      });
      return;
    }
    const phone = cleaned.replace(/^\+/, "");
    await clearSession(env, chatId);
    let record;
    try {
      record = await setRateLimitExempt(env, awaiting.ip, phone);
    } catch (e) {
      await sendRateLimitMenu(env, chatId, `❌ Couldn't save that exemption: ${escapeHtml(e.message || "unknown error")}`);
      return;
    }
    // record.ip (not awaiting.ip) — for an IPv6 address this is the
    // normalized /64 prefix actually stored (see normalizeIp in
    // security.js), which is what future requests are matched against.
    // Mobile carriers commonly rotate the rest of the address, so the
    // exemption is keyed to that stable prefix, not the exact address
    // typed in.
    await sendRateLimitMenu(env, chatId, `✅ Rate limiting turned OFF for <code>${escapeHtml(record.ip)}</code> — tied to +${escapeHtml(phone)}. Any existing block on this IP (e.g. from hitting the limit repeatedly) was also lifted, so they can book/rate again right away. Malware/brute-force/scanner protection still applies to this IP as normal.`);
    return;
  }

  // 🔓 Standalone unblock (see sendUnblockPrompt above) — clears the
  // block + strike count only, no rate-limit exemption attached.
  if (awaiting.type === "rlunblockip") {
    const ip = (msg.text ?? "").trim();
    if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) {
      await tgSendMessage(env, chatId, `That doesn't look like a valid IP address. Send just the address, e.g. <code>203.0.113.45</code>, or tap Cancel.`, {
        reply_markup: kb([[btn("❌ Cancel", "ratelimitmenu")]]),
      });
      return;
    }
    await clearSession(env, chatId);
    // Display the normalized /64 (for IPv6) so what's shown matches the
    // key actually cleared — isBlocked/adminUnblock normalize
    // internally regardless, this is just so the confirmation message
    // isn't misleading about what was matched.
    const normalized = normalizeIp(ip);
    const wasBlocked = await isBlocked(env, ip);
    await adminUnblock(env, ip);
    await sendRateLimitMenu(
      env,
      chatId,
      wasBlocked
        ? `✅ <code>${escapeHtml(normalized)}</code> was blocked — it's unblocked now and can book/rate again.`
        : `ℹ️ <code>${escapeHtml(normalized)}</code> wasn't actually blocked, but its strike count has been cleared anyway.`
    );
    return;
  }

  if (awaiting.type === "adminphone") {
    const userId = msg?.from?.id;
    const raw = (msg.text ?? "").trim();
    const cleaned = raw.replace(/[^\d+]/g, "");
    if (!/^\+?\d{7,15}$/.test(cleaned)) {
      await tgSendMessage(env, chatId, `That doesn't look like a valid number. Send it with your country code, e.g. <code>+919876543210</code>.`, {
        reply_markup: kb([[btn("❌ Cancel", "adminsecurity")]]),
      });
      return;
    }
    const phone = cleaned.replace(/^\+/, "");
    await setAdminPhone(env, userId, phone);
    await clearSession(env, chatId);
    await tgSendMessage(env, chatId, `✅ Saved.`);
    await sendAdminSecurityMenu(env, chatId, userId);
    return;
  }

  if (awaiting.type === "adminsetpw") {
    const userId = msg?.from?.id;
    const pw = (msg.text ?? "").trim();
    if (pw.length < 4) {
      await tgSendMessage(env, chatId, "Password must be at least 4 characters. Try again, or tap Cancel.", {
        reply_markup: kb([[btn("❌ Cancel", "adminsecurity")]]),
      });
      return;
    }
    await setCustomPassword(env, "admin", userId, pw);
    await clearSession(env, chatId);
    await tgSendMessage(env, chatId, "✅ Password updated. You'll need it any time you send 🔒 Log Out.");
    await sendAdminSecurityMenu(env, chatId, userId);
    return;
  }

  if (awaiting.type === "guidesetpw") {
    const guide = await getGuideByChatId(env, chatId);
    if (!guide) {
      await clearSession(env, chatId);
      return;
    }
    const pw = (msg.text ?? "").trim();
    if (pw.length < 4) {
      await tgSendMessage(env, chatId, "Password must be at least 4 characters. Try again, or tap Cancel.", {
        reply_markup: kb([[btn("❌ Cancel", "gsecurity")]]),
      });
      return;
    }
    await setCustomPassword(env, "guide", guide.id, pw);
    await clearSession(env, chatId);
    await tgSendMessage(env, chatId, "✅ Password updated. You'll need it any time you send 🔒 Log Out.");
    await sendGuideSecurityMenu(env, chatId, guide);
    return;
  }

  // ---- recovery flows — reachable even while the guide is locked, see
  // the bypass in handleTelegramAdminUpdate ----
  if (awaiting.type === "guideresetcode") {
    const guide = await getGuideByChatId(env, chatId);
    if (!guide) {
      await clearSession(env, chatId);
      return;
    }
    const code = (msg.text ?? "").trim();
    const matchedGuideId = await redeemGuideResetCode(env, code);
    if (!matchedGuideId || String(matchedGuideId) !== String(guide.id)) {
      await tgSendMessage(env, chatId, "❌ That code is invalid, expired, or belongs to a different account. Ask the admin for a fresh one, or try again.");
      return;
    }
    await clearSession(env, chatId);
    await tgSendMessage(env, chatId, "✅ Code accepted!");
    await startGuideResetNow(env, chatId);
    return;
  }

  if (awaiting.type === "guideresetpw") {
    const guide = await getGuideByChatId(env, chatId);
    if (!guide) {
      await clearSession(env, chatId);
      return;
    }
    const pw = (msg.text ?? "").trim();
    if (pw.length < 4) {
      await tgSendMessage(env, chatId, "Password must be at least 4 characters. Send it again.");
      return;
    }
    await setCustomPassword(env, "guide", guide.id, pw); // also clears the lock + reset flags
    await clearSession(env, chatId);
    await tgSendMessage(env, chatId, "✅ Password reset. You're unlocked — welcome back!");
    await sendGuideMenu(env, chatId, guide);
    return;
  }

  if (awaiting.type === "video") {
    const video = msg.video || (msg.document && /^video\//.test(msg.document.mime_type || "") ? msg.document : null);
    if (!video) {
      await tgSendMessage(env, chatId, "That's not a video — please send it as a normal video message, or tap Cancel.", {
        reply_markup: kb([[btn("❌ Cancel", "cancel")]]),
      });
      return;
    }
    const site = awaiting.site;
    // "hero" / "background" are the two whole-site video targets;
    // "slot" is any individual media slot registered in
    // MEDIA_SLOT_VIDEO_TARGETS (an experience card, an About Us photo,
    // a Why Visit journey, etc.) — see startVideoUploadForSlot above.
    const target = awaiting.target === "hero" || awaiting.target === "slot" ? awaiting.target : "background";
    const fileId = video.file_id;

    // Store the raw file_id (same pattern as images) under a key that
    // matches which video this actually is, then re-point the matching
    // config field at the stable proxy route that resolves it fresh on
    // every request — see content-api.js's handleVideoMedia. This is
    // what makes it "go live automatically": the website already reads
    // that field on every load, it just now points here instead of a
    // static filename.
    //   target "background" -> videos:<site>.global        -> background.global.videoUrl
    //   target "hero"        -> videos:<site>.hero          -> hero.videoUrl
    //   target "slot"         -> videos:<site>.slot_<key>    -> <contentPath>.video
    const videoKey = target === "hero" ? "hero" : target === "slot" ? `slot_${awaiting.slotKey}` : "global";
    const videosDoc = await getDoc(env, `videos:${site}`, {});
    videosDoc[videoKey] = fileId;
    const logLabel = target === "hero" ? "hero banner video" : target === "slot" ? `slot video (${awaiting.slotKey})` : "background video";
    await saveDoc(env, `videos:${site}`, videosDoc, { logChange: `Uploaded new ${logLabel}` });

    const proxyUrl = `${env.WORKER_BASE_URL || DEFAULT_WORKER_BASE_URL}/media-video/${site}/${videoKey}`;
    const override = await getDoc(env, `content:${site}`, {});
    let successLabel;
    if (target === "hero") {
      setPath(override, "hero.videoUrl", proxyUrl);
      setPath(override, "hero.videoEnabled", true);
      setPath(override, "hero.enabled", true);
      successLabel = "hero banner";
    } else if (target === "slot") {
      // Uses the seeded setter (not plain setPath) because a slot's
      // path can run through an array (e.g. whyVisit.journeys.0.
      // imageSlot) — plain setPath would create a brand-new
      // single-item array there and wholesale-wipe every OTHER
      // journey/highlight in the same array on save. Seeding from the
      // current merged content keeps every sibling intact.
      const base = defaultsFor("content", site);
      const merged = deepMerge(base, override);
      const path = awaiting.contentPath;
      setPathSeeded(override, merged, `${path}.video`, proxyUrl);
      setPathSeeded(override, deepMerge(base, override), `${path}.type`, "video");
      setPathSeeded(override, deepMerge(base, override), `${path}.enabled`, true);
      successLabel = "slot";
    } else {
      setPath(override, "background.global.videoUrl", proxyUrl);
      setPath(override, "background.global.videoEnabled", true);
      setPath(override, "background.global.enabled", true);
      successLabel = "background";
    }
    await saveDoc(env, `content:${site}`, override, { logChange: `Uploaded ${logLabel} → live` });

    await clearSession(env, chatId);
    await tgSendMessage(
      env,
      chatId,
      `✅ New ${successLabel === "slot" ? "video" : successLabel} video is live on <b>${SITE_LABELS[site] || site}</b> right now — no other steps needed.${successLabel === "slot" ? " That slot now shows the video (with a play button) instead of its old photo — switch it back any time from ✏️ Edit Website Text by setting that slot's \"type\" back to image." : ""}`,
      { reply_markup: kb([[btn("⬅️ Main Menu", "home")]]) }
    );
    return;
  }

  if (awaiting.type === "photo") {
    const photos = msg.photo;
    if (!photos || !photos.length) {
      await tgSendMessage(env, chatId, "That's not a photo — please send an image, or tap Cancel.", {
        reply_markup: kb([[btn("❌ Cancel", "cancel")]]),
      });
      return;
    }
    const fileId = photos[photos.length - 1].file_id; // largest size
    await saveLeaf(env, session, fileId, `Changed photo: ${awaiting.path}`);
    delete session.awaiting;
    await setSession(env, chatId, session);
    await renderTree(env, chatId, session, "✅ Photo updated!");
    return;
  }

  const text = msg.text ?? "";
  if (awaiting.type === "number") {
    const num = Number(text.replace(/[^\d.-]/g, ""));
    if (Number.isNaN(num)) {
      await tgSendMessage(env, chatId, "That doesn't look like a number. Try again, or tap Cancel.", {
        reply_markup: kb([[btn("❌ Cancel", "cancel")]]),
      });
      return;
    }
    await saveLeaf(env, session, num, `Changed ${awaiting.path} → ${num}`);
  } else {
    await saveLeaf(env, session, text, `Changed ${awaiting.path} → "${truncateLabel(text)}"`);
  }
  delete session.awaiting;
  await setSession(env, chatId, session);
  await renderTree(env, chatId, session, "✅ Saved!");
}

// IMPORTANT: this saves only the RAW override doc (not the merged
// defaults+override view) — a single changed leaf gets written back on
// top of whatever overrides already existed, nothing else. Previously
// this saved the full `merged` object (defaults + overrides together),
// which meant editing even one photo silently wrote every OTHER photo's
// key into the override doc too, holding its plain default filename
// instead of a real Telegram file_id. Since /media resolves override
// values as Telegram file_ids, that "poisoned" every untouched image on
// the site with a broken link. Only ever persist what was actually
// changed.
async function saveLeaf(env, session, value, logChange) {
  const docKey = docKeyFor(session.kind, session.site);
  const base = defaultsFor(session.kind, session.site);
  const override = await getDoc(env, docKey, Array.isArray(base) ? [] : {});
  // Seeded from the current merged content (base + override) so editing
  // one field never blanks out sibling items in the same array — see
  // setPathSeeded in store.js.
  const merged = deepMerge(base, override);
  setPathSeeded(override, merged, session.awaiting.path, value);
  await saveDoc(env, docKey, override, { logChange });
}

// Wipes every photo override for the current site back to the static
// defaults baked into config.js (i.e. clears the images:<site> doc
// entirely). Also the fix for any already-poisoned doc from the old
// saveLeaf bug, if the self-healing read-side guard is ever bypassed.
async function resetAllImages(env, chatId) {
  const session = await getSession(env, chatId);
  if (!session || session.kind !== "images") return sendMainMenu(env, chatId);
  const docKey = docKeyFor(session.kind, session.site);
  await saveDoc(env, docKey, {}, { logChange: "Reset ALL photos to default" });
  session.path = [];
  await setSession(env, chatId, session);
  return renderTree(env, chatId, session, "🔄 All photos reset to their defaults.");
}

// Removes a single key's override, so that one photo falls back to the
// static default again, leaving every other admin-uploaded photo alone.
async function resetOneImage(env, chatId, key) {
  const session = await getSession(env, chatId);
  if (!session || session.kind !== "images") return sendMainMenu(env, chatId);
  const docKey = docKeyFor(session.kind, session.site);
  const override = await getDoc(env, docKey, {});
  delete override[key];
  await saveDoc(env, docKey, override, { logChange: `Reset photo to default: ${key}` });
  delete session.awaiting;
  await setSession(env, chatId, session);
  return renderTree(env, chatId, session, `↩️ ${humanize(key)} reset to default.`);
}

// ---------------- GENERIC RESET (content / prices / highlights / discounts / ratings) ----------------
// Same idea as the images reset above, just working off whatever tree
// the admin is currently browsing instead of being hard-coded to
// photos. "Reset this section" clears the override at exactly the path
// you're standing in (e.g. Destinations, or one destination inside it)
// and falls back to the code's default for that path — everything else
// on the site, and every other site, is untouched.

async function resetSection(env, chatId) {
  const session = await getSession(env, chatId);
  if (!session || session.kind === "images") return sendMainMenu(env, chatId);
  const docKey = docKeyFor(session.kind, session.site);
  const base = defaultsFor(session.kind, session.site);
  const override = await getDoc(env, docKey, Array.isArray(base) ? [] : {});
  const path = session.path.join(".");
  deletePath(override, path);
  await saveDoc(env, docKey, override, { logChange: `Reset "${path || "(top level)"}" to default` });
  const label = humanize(session.path[session.path.length - 1] || "this section");
  return renderTree(env, chatId, session, `↩️ ${label} reset to default.`);
}

// "Reset ALL <category>" is destructive enough (it throws away every
// tweak made anywhere in that whole document) that it asks for a
// confirming tap before it actually runs.
async function confirmResetAll(env, chatId) {
  const session = await getSession(env, chatId);
  if (!session) return sendMainMenu(env, chatId);
  const catLabel = CATEGORIES.find((c) => c.kind === session.kind)?.label || session.kind;
  const scope = SITE_LABELS[session.site] ? ` for ${SITE_LABELS[session.site]}` : "";
  await tgSendMessage(
    env,
    chatId,
    `⚠️ This resets <b>everything</b> in ${catLabel}${scope} back to default — every edit you've made in this section, not just the one you're looking at.\n\nAre you sure?`,
    { reply_markup: kb([[btn("✅ Yes, reset it all", "resetallconfirm")], [btn("❌ Cancel", "cancel")]]) }
  );
}

async function resetAllForCurrentTree(env, chatId) {
  const session = await getSession(env, chatId);
  if (!session) return sendMainMenu(env, chatId);
  const docKey = docKeyFor(session.kind, session.site);
  const base = defaultsFor(session.kind, session.site);
  await saveDoc(env, docKey, Array.isArray(base) ? [] : {}, {
    logChange: `Reset ALL of ${session.kind}${session.site ? ":" + session.site : ""} to default`,
  });
  session.path = [];
  await setSession(env, chatId, session);
  return renderTree(env, chatId, session, "🔄 This whole section is back to default.");
}

// ---------------- RESET EVERYTHING (the big red button) ----------------
// Wipes every override doc for every site — text, photos, prices,
// highlights, ratings, and the global discounts — back to whatever is
// baked into the code. Two-tap confirm because there's no undo.

async function confirmResetEverything(env, chatId) {
  await tgSendMessage(
    env,
    chatId,
    "🧨 <b>Reset EVERYTHING?</b>\n\nThis puts the <b>entire website</b> — all text, all photos, all prices, highlights, ratings, and discounts, on all three sites — back to exactly how it is in the code, undoing every change ever made from this bot.\n\nThis cannot be undone. Are you sure?",
    { reply_markup: kb([[btn("‼️ Yes, reset the whole website", "resetworldconfirm")], [btn("❌ Cancel", "cancel")]]) }
  );
}

async function resetEverything(env, chatId) {
  const perSiteKinds = ["content", "images", "prices", "highlights", "ratings"];
  for (const site of SITES) {
    for (const kind of perSiteKinds) {
      const base = defaultsFor(kind, site);
      await saveDoc(env, docKeyFor(kind, site), Array.isArray(base) ? [] : {}, {
        logChange: `Reset ALL ${kind} for ${site} (full site reset)`,
      });
    }
  }
  await saveDoc(env, "discounts:global", {}, { logChange: "Reset ALL discounts (full site reset)" });
  await clearSession(env, chatId);
  await tgSendMessage(env, chatId, "🔄 Done — the whole website is back to its default, out-of-the-box state.", {
    reply_markup: kb([[btn("🏠 Main Menu", "home")]]),
  });
}

// ---------------- ARRAY ADD / DELETE ----------------

async function addArrayItem(env, chatId) {
  const session = await getSession(env, chatId);
  if (!session) return sendMainMenu(env, chatId);
  const { docKey, merged } = await loadMerged(env, session.kind, session.site);
  const arr = session.path.length ? getPath(merged, session.path.join(".")) : merged;
  if (!Array.isArray(arr)) return renderTree(env, chatId, session);

  const template = arr.length ? JSON.parse(JSON.stringify(arr[arr.length - 1])) : {};
  clearStringsDeep(template);
  // BUG FIX: clearStringsDeep above blanks every field to a generic
  // placeholder based on the field's *name* — so an "id" field always
  // became the exact same value ("New Id" for a string id, 0 for a
  // numeric one) no matter how many items you added. Menu-style arrays
  // (bambooMenu, lunchThali, etc.) use that id as the key the website
  // tracks each item's quantity/amount under — so adding 2 new items
  // gave them the SAME id, and typing an amount for one on the site
  // updated both, because as far as the site's state was concerned they
  // were literally the same item. Regenerating a real, unique id for
  // every new item (and everything nested inside it) fixes that.
  const existingIds = new Set();
  collectIds(arr, existingIds);
  assignFreshIds(template, existingIds);
  arr.push(template);

  await saveDoc(env, docKey, merged, { logChange: `Added new item to ${session.path.join(".") || "(top level)"}` });
  await renderTree(env, chatId, session, "➕ Added a new item (copy of the last one — edit its fields now).");
}

function clearStringsDeep(obj) {
  if (Array.isArray(obj)) {
    obj.forEach(clearStringsDeep);
  } else if (obj && typeof obj === "object") {
    for (const k of Object.keys(obj)) {
      if (typeof obj[k] === "string") obj[k] = "New " + humanize(k);
      else if (typeof obj[k] === "number") obj[k] = 0;
      else clearStringsDeep(obj[k]);
    }
  }
}

// Walks any value (typically a sibling array like bambooMenu) and
// collects every "id" field's current value (as a string, for easy
// comparison) into `set`, so a freshly generated id can be checked
// against every id already in use before it's assigned.
function collectIds(node, set) {
  if (Array.isArray(node)) {
    node.forEach((n) => collectIds(n, set));
  } else if (node && typeof node === "object") {
    for (const k of Object.keys(node)) {
      if (k === "id" && (typeof node[k] === "string" || typeof node[k] === "number")) {
        set.add(String(node[k]));
      } else {
        collectIds(node[k], set);
      }
    }
  }
}

// Generates one id guaranteed not to collide with anything in
// `existingIds`, reserving it in that set immediately so a second call
// in the same batch can't hand out the same value twice. Keeps the
// original id's type (numeric ids — e.g. the 0,1,2… activity list —
// stay numeric; string ids get a short random string id).
function freshId(existingIds, numeric) {
  if (numeric) {
    let n = 0;
    while (existingIds.has(String(n))) n++;
    existingIds.add(String(n));
    return n;
  }
  let candidate;
  do {
    candidate = "item-" + Math.random().toString(36).slice(2, 8);
  } while (existingIds.has(candidate));
  existingIds.add(candidate);
  return candidate;
}

// Deep-walks the newly-added template and replaces every "id" field
// (at any depth) with a fresh, unique value from freshId() above.
function assignFreshIds(node, existingIds) {
  if (Array.isArray(node)) {
    node.forEach((n) => assignFreshIds(n, existingIds));
  } else if (node && typeof node === "object") {
    for (const k of Object.keys(node)) {
      if (k === "id" && (typeof node[k] === "string" || typeof node[k] === "number")) {
        node[k] = freshId(existingIds, typeof node[k] === "number");
      } else {
        assignFreshIds(node[k], existingIds);
      }
    }
  }
}

// ---------------- REORDER AN ITEM (nav items, highlights, meals, ...) ----------------
// Swaps an array item with its neighbor and re-saves — the ⬆️/⬇️
// buttons next to each row in renderTree. Same "save the merged view"
// convention as addArrayItem above, so a reorder always sticks even if
// nothing else on that item was ever overridden before.
async function moveItem(env, chatId, indexStr, delta) {
  const session = await getSession(env, chatId);
  if (!session) return sendMainMenu(env, chatId);
  const { docKey, merged } = await loadMerged(env, session.kind, session.site);
  const arr = session.path.length ? getPath(merged, session.path.join(".")) : merged;
  if (!Array.isArray(arr)) return renderTree(env, chatId, session);

  const idx = Number(indexStr);
  const newIdx = idx + delta;
  if (Number.isNaN(idx) || newIdx < 0 || newIdx >= arr.length) return renderTree(env, chatId, session);

  const tmp = arr[idx];
  arr[idx] = arr[newIdx];
  arr[newIdx] = tmp;

  await saveDoc(env, docKey, merged, {
    logChange: `Reordered item #${idx + 1} \u2194 #${newIdx + 1} in ${session.path.join(".") || "(top level)"}`,
  });
  await renderTree(env, chatId, session, "\ud83d\udd00 Reordered.");
}

async function deleteChild(env, chatId, keyAndSelf) {
  const session = await getSession(env, chatId);
  if (!session) return sendMainMenu(env, chatId);
  const [key] = keyAndSelf.split(":");
  const { docKey, merged } = await loadMerged(env, session.kind, session.site);

  const parentPath = session.path.slice(0, -1).join(".");
  const parent = parentPath ? getPath(merged, parentPath) : merged;
  const idx = Number(session.path[session.path.length - 1]);

  if (Array.isArray(parent) && !Number.isNaN(idx)) {
    parent.splice(idx, 1);
    session.path.pop();
    await saveDoc(env, docKey, merged, { logChange: `Deleted item #${idx + 1} from ${parentPath}` });
    await setSession(env, chatId, session);
    return renderTree(env, chatId, session, "🗑️ Deleted.");
  }
  return renderTree(env, chatId, session);
}

// ---------------- DISCOUNTS & SALES quick flows ----------------
// (These ride on the same generic tree for anything detailed, but
// offer one-tap shortcuts for the two most common actions.)

const SALE_PRESETS = [0, 5, 10, 15, 20, 25, 30];

export async function sendDiscountsMenu(env, chatId) {
  const rows = [
    [btn("🏷️ Put a package on sale", "salepick:krem-chympe")],
    [btn("🎁 Generate Referral Card", "refcard")],
    [btn("📋 Full discounts editor (codes, bulk tiers, seasons)", "site:discounts:global")],
    [btn("⬅️ Main Menu", "home")],
  ];
  await tgSendMessage(env, chatId, "💰 <b>Discounts & Sales</b>", { reply_markup: kb(rows) });
}

// ---------------- 🎁 REFERRAL CARD (guided flow) ----------------
// A short back-and-forth (site -> package -> guest name -> number of
// people -> mobile number -> which parts apply -> quantities -> discount)
// that ends with a unique, single-use code saved into the private
// referrals:global doc (NOT discounts:global, which the website serves
// publicly) and a shareable card (logo + offer details) sent back to the
// admin to forward on WhatsApp/Telegram. The code only unlocks on the
// booking form for the mobile number entered here, and only discounts as
// many guests as this card was made for. See referrals.js for code
// generation, matching and card rendering.
//
// PRICING IS NEVER TYPED: every ₹ figure on the card is computed from
// this site's live prices doc (the same numbers under 💰 Edit Prices) —
// the admin only answers which parts of the package apply (jeep,
// camping, activities...) and how many of each food/camping item, and
// startReferralPricing/buildReferralBreakdown below do the maths.

async function startReferralFlow(env, chatId) {
  // Pick the exact package in one tap. The home site has no booking form,
  // so a code for it could never be used and it isn't offered.
  const rows = REFERRAL_PACKAGES.map((o) => [btn(o.button, `refpkg:${o.site}:${o.packageKey}`)]);
  rows.push([btn("❌ Cancel", "refcancel")]);
  await tgSendMessage(env, chatId, "🎁 <b>Referral Card</b>\n\nWhich package is this for?", { reply_markup: kb(rows) });
}

// The three packages a referral card can be made for. `packageKey` matches
// the site's own package keys (sharedTour / privatePackage). Wilderness
// Expedition sells one package, which the site codes as "sharedTour".
const REFERRAL_PACKAGES = [
  { site: "krem-chympe", packageKey: "sharedTour", label: "Shared Package", button: "🌊 Krem Chympe — Shared Package" },
  { site: "krem-chympe", packageKey: "privatePackage", label: "Private Tour", button: "🌊 Krem Chympe — Private Tour" },
  { site: "wilderness-expedition", packageKey: "sharedTour", label: "Expedition Package", button: "🥾 Wilderness — Expedition Package" },
];

async function chooseReferralPackage(env, chatId, site, packageKey) {
  const opt = REFERRAL_PACKAGES.find((o) => o.site === site && o.packageKey === packageKey);
  if (!opt) return startReferralFlow(env, chatId); // stale / unknown button — start over
  await setSession(env, chatId, {
    referral: { site: opt.site, packageKey: opt.packageKey, packageLabel: opt.label },
    awaiting: { type: "refName" },
  });
  await tgSendMessage(env, chatId, `<b>${SITE_LABELS[opt.site] || opt.site} — ${opt.label}</b>\n\nGuest's name?`, {
    reply_markup: kb([[btn("❌ Cancel", "refcancel")]]),
  });
}

async function chooseReferralSite(env, chatId, site) {
  await setSession(env, chatId, { referral: { site }, awaiting: { type: "refPackage" } });
  await tgSendMessage(env, chatId, `Package name for <b>${SITE_LABELS[site] || site}</b>?\n\nExample: <code>Private Package</code> or <code>Wilderness Expedition — 6D/5N</code>`, {
    reply_markup: kb([[btn("❌ Cancel", "refcancel")]]),
  });
}

async function cancelReferralFlow(env, chatId) {
  await clearSession(env, chatId);
  await sendDiscountsMenu(env, chatId);
}

// Called from handleAwaitedInput for awaiting.type in
// {refPackage, refName, refPeople, refMobile, refPkgOptions, refQty,
// refExtrasChoice, refDiscount} — kept together here since they're one
// linear conversation.
async function handleReferralAwaitedInput(env, chatId, session, msg, type) {
  const text = (msg.text ?? "").trim();
  if (!text) {
    await tgSendMessage(env, chatId, "Please send some text, or tap Cancel.", { reply_markup: kb([[btn("❌ Cancel", "refcancel")]]) });
    return;
  }

  if (type === "refPackage") {
    session.referral.packageLabel = text;
    session.awaiting = { type: "refName" };
    await setSession(env, chatId, session);
    await tgSendMessage(env, chatId, "Guest's name?", { reply_markup: kb([[btn("❌ Cancel", "refcancel")]]) });
    return;
  }

  if (type === "refName") {
    session.referral.visitorName = text;
    session.awaiting = { type: "refPeople" };
    await setSession(env, chatId, session);
    await tgSendMessage(env, chatId, "How many people is this card for? (a whole number, e.g. <code>1</code>)\n\nThe discount will only apply to this many guests — anyone booked beyond that pays the normal price.", {
      reply_markup: kb([[btn("❌ Cancel", "refcancel")]]),
    });
    return;
  }

  if (type === "refPeople") {
    const people = Number(text);
    if (!Number.isInteger(people) || people < 1 || people > 100) {
      await tgSendMessage(env, chatId, "Send a whole number of people between 1 and 100, e.g. <code>2</code>.", {
        reply_markup: kb([[btn("❌ Cancel", "refcancel")]]),
      });
      return;
    }
    session.referral.people = people;
    session.awaiting = { type: "refMobile" };
    await setSession(env, chatId, session);
    await tgSendMessage(env, chatId, "Guest's mobile number? (the same number they'll enter as their WhatsApp number on the booking form — e.g. <code>9876543210</code> or <code>+91 98765 43210</code>)\n\nThe code will only unlock for this number.", {
      reply_markup: kb([[btn("❌ Cancel", "refcancel")]]),
    });
    return;
  }

  if (type === "refMobile") {
    const mobile = normalizeMobile(text);
    if (!mobile) {
      await tgSendMessage(env, chatId, "That doesn't look like a valid mobile number — I need at least 10 digits. Try again, e.g. <code>9876543210</code>.", {
        reply_markup: kb([[btn("❌ Cancel", "refcancel")]]),
      });
      return;
    }
    session.referral.mobile = mobile;
    await setSession(env, chatId, session);
    return startReferralPricing(env, chatId, session);
  }

  if (type === "refPkgOptions") {
    // Waiting on button taps — typed text is just a nudge to use them.
    await tgSendMessage(env, chatId, "Tap the buttons above to switch each part on/off, then tap Continue — or Cancel.", {
      reply_markup: kb([[btn("❌ Cancel", "refcancel")]]),
    });
    return;
  }

  if (type === "refQty") {
    const fields = referralQtyFields(session);
    const qtys = parseReferralQty(text, fields);
    if (qtys === null) {
      await tgSendMessage(
        env,
        chatId,
        `Couldn't read that. One per line as <code>name: number</code>, matching the names exactly (copy them from the list above), or tap "None of these".`,
        { reply_markup: kb([[btn("None of these", "refqtynone")], [btn("❌ Cancel", "refcancel")]]) }
      );
      return;
    }
    return finalizeReferralBreakdown(env, chatId, session, qtys);
  }

  if (type === "refExtrasChoice") {
    // Waiting on button taps — typed text is just a nudge to use them.
    await tgSendMessage(env, chatId, "Tap ✅/🚫 above to toggle each one, then tap Continue — or Cancel.", {
      reply_markup: kb([[btn("❌ Cancel", "refcancel")]]),
    });
    return;
  }

  if (type === "refDiscount") {
    const isPercent = /%\s*$/.test(text);
    const value = Number(text.replace(/[^0-9.]/g, ""));
    if (!value || value <= 0 || (isPercent && value > 100)) {
      await tgSendMessage(env, chatId, "Send a valid percent (e.g. <code>10%</code>) or flat ₹ amount (e.g. <code>500</code>).", {
        reply_markup: kb([[btn("❌ Cancel", "refcancel")]]),
      });
      return;
    }

    const referral = await createReferralCode(env, {
      ...session.referral,
      discountType: isPercent ? "percent" : "flat",
      discountValue: Math.round(value),
    });

    await clearSession(env, chatId);
    await sendReferralCard(env, chatId, referral);
    await tgSendMessage(env, chatId, `✅ Code is live — it unlocks only for the mobile number ending ${referral.mobile.slice(-4)}, covers ${referral.people} guest${referral.people === 1 ? "" : "s"}, and works once.`, {
      reply_markup: kb([[btn("🎁 Make Another", "refcard")], [btn("⬅️ Main Menu", "home")]]),
    });
    return;
  }
}

// Shared "how much discount?" prompt — the last step of the referral flow.
async function askReferralDiscount(env, chatId, session) {
  session.awaiting = { type: "refDiscount" };
  await setSession(env, chatId, session);
  await tgSendMessage(
    env,
    chatId,
    "Discount for this guest? Reply with a percent like <code>10%</code>, or a flat ₹ amount like <code>500</code>.",
    { reply_markup: kb([[btn("❌ Cancel", "refcancel")]]) }
  );
}

// ---------------------------------------------------------------------
// Automatic pricing — the bot already knows every unit price (they're
// the same numbers the admin sets under 💰 Edit Prices), so instead of
// typing a lump total and re-typing each add-on's amount, the admin
// only answers which parts of the package apply and how many of each
// food/camping item — every ₹ figure is computed from the live prices
// doc. The result is fed into the SAME include/exclude toggle screen
// (extrasChoiceMarkup below) used before, so nothing else changes.
// ---------------------------------------------------------------------

// Kicks off pricing right after the mobile number is collected: loads
// this site's live prices doc, and either shows the private-package
// on/off toggles or (Shared Tour/Expedition, which has no such options)
// goes straight to the food-quantity question.
async function startReferralPricing(env, chatId, session) {
  const site = session.referral.site;
  const { merged: prices } = await loadMerged(env, "prices", site);
  session.referral._prices = prices;

  if (session.referral.packageKey === "sharedTour") {
    const { merged: discounts } = await loadMerged(env, "discounts", null);
    session.referral._salePct = (discounts.saleBySite && discounts.saleBySite[site] && discounts.saleBySite[site][session.referral.packageKey]) || 0;
  }

  if (session.referral.packageKey === "privatePackage") {
    session.referral._opts = { jeep: false, adventure: true, camping: false, campingMeals: false };
    session.awaiting = { type: "refPkgOptions" };
    await setSession(env, chatId, session);
    await tgSendMessage(env, chatId, privateOptToggleText(), { reply_markup: privateOptToggleMarkup(session.referral._opts) });
    return;
  }

  await setSession(env, chatId, session);
  return sendReferralQtyPrompt(env, chatId, session);
}

function privateOptToggleText() {
  return (
    "Which parts of the Private Tour is this booking for? Tap to switch each on/off, then Continue.\n\n" +
    "(Camping swaps the Local Guide fee for the Overnight Guide fee, same as the booking form.)"
  );
}
function privateOptToggleMarkup(opts) {
  const rows = [
    [btn(`${opts.jeep ? "✅" : "⬜"} 4x4 Jeep`, "refopt:jeep")],
    [btn(`${opts.adventure ? "✅" : "⬜"} Adventure Activities`, "refopt:adventure")],
    [btn(`${opts.camping ? "✅" : "⬜"} Camping (overnight)`, "refopt:camping")],
  ];
  if (opts.camping) rows.push([btn(`${opts.campingMeals ? "✅" : "⬜"} Camping Meals`, "refopt:campingMeals")]);
  rows.push([btn("▶️ Continue", "refoptdone")]);
  rows.push([btn("❌ Cancel", "refcancel")]);
  return kb(rows);
}

async function toggleReferralPkgOption(env, chatId, messageId, field) {
  const session = await getSession(env, chatId);
  if (!session || !session.referral || session.awaiting?.type !== "refPkgOptions" || !session.referral._opts) return;
  const opts = session.referral._opts;
  if (!(field in opts)) return;
  opts[field] = !opts[field];
  if (field === "camping" && !opts.camping) opts.campingMeals = false; // turning camping off clears meals too
  await setSession(env, chatId, session);
  await tgEditMessageText(env, chatId, messageId, privateOptToggleText(), { reply_markup: privateOptToggleMarkup(opts) });
}

async function finishReferralPkgOptions(env, chatId, messageId) {
  const session = await getSession(env, chatId);
  if (!session || !session.referral || session.awaiting?.type !== "refPkgOptions") return;
  return sendReferralQtyPrompt(env, chatId, session);
}

// The food/camping items this package needs a quantity for, as
// {key, label} pairs — key is used internally, label is what the admin
// types back and what ends up on the invoice line.
function referralQtyFields(session) {
  const PRICES = session.referral._prices;
  const fields = [];
  if (session.referral.packageKey === "privatePackage") {
    const PP = PRICES.privatePackage || {};
    (PP.thaliTypes || []).forEach((th) => fields.push({ key: `thali:${th.id}`, label: th.name }));
    if (session.referral._opts && session.referral._opts.camping) {
      fields.push({ key: "tents", label: "Camping Tents" });
      (PRICES.bambooMenu || []).forEach((item) => fields.push({ key: `bamboo:${item.id}`, label: item.name }));
    }
  } else {
    const ST = PRICES.sharedTour || {};
    (ST.thaliTypes || []).forEach((th) => fields.push({ key: `thali:${th.id}`, label: th.name }));
  }
  return fields;
}

async function sendReferralQtyPrompt(env, chatId, session) {
  const fields = referralQtyFields(session);
  session.awaiting = { type: "refQty" };
  await setSession(env, chatId, session);
  if (!fields.length) {
    // Nothing needs a quantity (e.g. no thali types configured) — go
    // straight to building the breakdown from what's already known.
    return finalizeReferralBreakdown(env, chatId, session, {});
  }
  const list = fields.map((f) => `${f.label}: 0`).join("\n");
  await tgSendMessage(
    env,
    chatId,
    `How many of each? One per line as <code>name: number</code> (send <code>0</code> or leave a line out for none):\n\n` +
      `<code>${escapeHtml(list)}</code>`,
    { reply_markup: kb([[btn("None of these", "refqtynone")], [btn("❌ Cancel", "refcancel")]]) }
  );
}

async function skipReferralQty(env, chatId) {
  const session = await getSession(env, chatId);
  if (!session || !session.referral || session.awaiting?.type !== "refQty") return;
  return finalizeReferralBreakdown(env, chatId, session, {});
}

// Parses "name: number" lines against the known field labels for this
// package (case-insensitive, exact match). Returns {key: qty, ...}, or
// null if a line couldn't be matched to a real item.
function parseReferralQty(text, fields) {
  const t = String(text || "").trim();
  if (/^(none|no|skip|0)$/i.test(t)) return {};
  const byLabel = new Map(fields.map((f) => [f.label.trim().toLowerCase(), f]));
  const qtys = {};
  for (const lineRaw of t.split(/\n+/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    const idx = line.lastIndexOf(":");
    if (idx < 0) return null;
    const label = line.slice(0, idx).trim().toLowerCase();
    const num = Number(line.slice(idx + 1).replace(/[^0-9.]/g, ""));
    const field = byLabel.get(label);
    if (!field || !Number.isFinite(num) || num < 0) return null;
    qtys[field.key] = Math.round(num);
  }
  return qtys;
}

// Turns the admin's on/off + quantity answers into itemized breakdown
// lines, using ONLY unit prices already stored in this site's prices
// doc — nothing here is typed by the admin. Every line defaults to
// excluded from the discount (included:false), same as before; the
// admin flips the ones they want to include on the next screen.
function buildReferralBreakdown(session, qtys) {
  const r = session.referral;
  const PRICES = r._prices;
  const lines = [];
  const push = (label, amount) => {
    if (amount > 0) lines.push({ label, amount: Math.round(amount), included: false });
  };

  if (r.packageKey === "privatePackage") {
    const PP = PRICES.privatePackage || {};
    const opts = r._opts || {};
    const people = r.people;
    if (opts.jeep) push("4x4 Jeep", PP.jeep);
    if (opts.camping) push("Overnight Guide", PP.overnightGuide);
    else push("Local Guide", PP.guide);
    if (opts.adventure) push(`Adventure Activities (${people} people)`, people * PP.adventurePerPerson);
    (PP.thaliTypes || []).forEach((th) => {
      const qty = qtys[`thali:${th.id}`] || 0;
      if (qty > 0) push(`${th.name} x${qty}`, qty * PP.lunchThaliPrice);
    });
    if (opts.camping) {
      const tents = qtys.tents || 0;
      if (tents > 0) push(`Camping Tents x${tents}`, tents * PP.campingTent);
      if (opts.campingMeals) push(`Camping Meals (${people} people)`, people * PP.campingMealsPerPerson);
      (PRICES.bambooMenu || []).forEach((item) => {
        const qty = qtys[`bamboo:${item.id}`] || 0;
        if (qty > 0) push(`${item.name} x${qty}`, qty * item.price);
      });
    }
  } else {
    const ST = PRICES.sharedTour || {};
    const salePct = r._salePct || 0;
    const effectivePerPerson = salePct ? Math.round(ST.perPerson * (1 - salePct / 100)) : ST.perPerson;
    push(`Package (${r.people} × ₹${effectivePerPerson})`, r.people * effectivePerPerson);
    (ST.thaliTypes || []).forEach((th) => {
      const qty = qtys[`thali:${th.id}`] || 0;
      if (qty > 0) push(`${th.name} x${qty}`, qty * ST.lunchThaliPrice);
    });
  }
  return lines;
}

async function finalizeReferralBreakdown(env, chatId, session, qtys) {
  const breakdown = buildReferralBreakdown(session, qtys);
  if (!breakdown.length) {
    await tgSendMessage(env, chatId, "That comes to ₹0 — switch at least one part on (or add a quantity) and try again.", {
      reply_markup: kb([[btn("❌ Cancel", "refcancel")]]),
    });
    return;
  }
  session.referral.extras = breakdown;
  session.referral.originalAmount = breakdown.reduce((s, e) => s + e.amount, 0);
  delete session.referral._prices;
  delete session.referral._opts;
  delete session.referral._salePct;
  await setSession(env, chatId, session);
  return startReferralExtrasChoice(env, chatId, session);
}

function extrasChoiceText(originalAmount) {
  return `Package price: ₹${originalAmount}\n\nTap each one to switch it between excluded (default) and included in the discount, then tap Continue.`;
}
function extrasChoiceMarkup(extras) {
  const rows = extras.map((e, i) => [
    btn(`${e.included ? "✅" : "🚫"} ${e.label} (₹${e.amount})${e.included ? " — included" : ""}`, `refextratoggle:${i}`),
  ]);
  rows.push([btn("▶️ Continue", "refextradone")]);
  rows.push([btn("❌ Cancel", "refcancel")]);
  return kb(rows);
}

// No extras at all — skip straight to the discount question.
async function startReferralExtrasChoice(env, chatId, session) {
  if (!session.referral.extras || !session.referral.extras.length) {
    return askReferralDiscount(env, chatId, session);
  }
  session.awaiting = { type: "refExtrasChoice" };
  const sent = await tgSendMessage(env, chatId, extrasChoiceText(session.referral.originalAmount), {
    reply_markup: extrasChoiceMarkup(session.referral.extras),
  });
  session.referral.extrasMessageId = sent && sent.result && sent.result.message_id;
  await setSession(env, chatId, session);
}

// Button press: flip one extra between excluded (default) and included.
async function toggleReferralExtra(env, chatId, messageId, index) {
  const session = await getSession(env, chatId);
  if (!session || !session.referral || session.awaiting?.type !== "refExtrasChoice" || !Array.isArray(session.referral.extras)) {
    return; // stale button — the flow was already finished/cancelled
  }
  const extra = session.referral.extras[index];
  if (!extra) return;
  extra.included = !extra.included;
  await setSession(env, chatId, session);
  await tgEditMessageText(env, chatId, session.referral.extrasMessageId || messageId, extrasChoiceText(session.referral.originalAmount), {
    reply_markup: extrasChoiceMarkup(session.referral.extras),
  });
}

// "Continue" — extras are locked in, move on to the discount question.
async function finishReferralExtras(env, chatId, messageId) {
  const session = await getSession(env, chatId);
  if (!session || !session.referral || session.awaiting?.type !== "refExtrasChoice") return;
  return askReferralDiscount(env, chatId, session);
}

async function sendSalePackagePicker(env, chatId, site) {
  const { merged } = await loadMerged(env, "prices", site);
  const packages = Object.keys(merged || {}).filter((k) => typeof merged[k] === "object" && !Array.isArray(merged[k]));
  const rows = packages.map((p) => [btn(humanize(p), `salepick2:${site}:${p}`)]);
  rows.push([btn(site === "krem-chympe" ? "🥾 Switch to Wilderness" : "🌊 Switch to Krem Chympe", `salepick:${site === "krem-chympe" ? "wilderness-expedition" : "krem-chympe"}`)]);
  rows.push([btn("⬅️ Back", "pick:discounts")]);
  await tgSendMessage(env, chatId, `Which package on <b>${SITE_LABELS[site]}</b>?`, { reply_markup: kb(rows) });
}

async function handleSaleShortcut(env, chatId, rest) {
  // rest: [site, pkg, pct]  (pct present once a preset is tapped)
  if (rest.length === 2) {
    const [site, pkg] = rest;
    const rows = chunk(
      SALE_PRESETS.map((pct) => btn(pct === 0 ? "No sale" : `${pct}% off`, `sale:${site}:${pkg}:${pct}`)),
      3
    );
    rows.push([btn("⬅️ Back", `salepick:${site}`)]);
    await tgSendMessage(env, chatId, `Sale for <b>${humanize(pkg)}</b> — pick a discount:`, { reply_markup: kb(rows) });
    return;
  }
  const [site, pkg, pctStr] = rest;
  const pct = Number(pctStr);
  const { merged } = await loadMerged(env, "discounts", null);
  merged.saleBySite = merged.saleBySite || {};
  merged.saleBySite[site] = merged.saleBySite[site] || {};
  if (pct > 0) merged.saleBySite[site][pkg] = pct;
  else delete merged.saleBySite[site][pkg];
  await saveDoc(env, "discounts:global", merged, {
    logChange: pct > 0 ? `Sale set: ${site}/${pkg} → ${pct}% off` : `Sale removed: ${site}/${pkg}`,
  });
  await tgSendMessage(
    env,
    chatId,
    pct > 0 ? `✅ ${humanize(pkg)} is now ${pct}% off on the website!` : `✅ Sale removed from ${humanize(pkg)}.`,
    { reply_markup: kb([[btn("⬅️ Main Menu", "home")]]) }
  );
}

async function toggleSeasonal(env, chatId, idx) {
  const { merged } = await loadMerged(env, "discounts", null);
  if (merged.seasonal?.[idx]) {
    merged.seasonal[idx].active = !merged.seasonal[idx].active;
    await saveDoc(env, "discounts:global", merged, { logChange: `Seasonal #${idx + 1} → ${merged.seasonal[idx].active ? "ON" : "OFF"}` });
  }
  await sendDiscountsMenu(env, chatId);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
