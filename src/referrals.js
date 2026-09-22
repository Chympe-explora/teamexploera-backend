/**
 * referrals.js — admin-generated, single-use referral codes with a
 * shareable "card" (site logo + guest + number of guests + price +
 * discount + amount due + code) that the admin forwards to ONE
 * specific guest.
 *
 * HOW A CODE BEHAVES
 *   • It belongs to one guest: the card records their name, their
 *     mobile number and how many people it covers.
 *   • The booking form only offers the "Referral / Discount Code" box
 *     when the mobile number (and name) the visitor typed match a live
 *     card — and the code itself only validates against that same
 *     mobile number. A code forwarded to someone else is useless.
 *   • The discount only applies to as many guests as the card was made
 *     for. A card for 1 person on a booking for 3 discounts 1 person's
 *     share; the other 2 pay the normal price (computeReferralDiscount).
 *   • It works exactly once. The moment a booking using it is submitted
 *     it is claimed atomically (Durable Object — see status-store.js
 *     claimOnce) and is expired for everyone from then on. A booking
 *     that later gets REJECTED does not give the code back — the admin
 *     can simply issue a fresh card.
 *
 * STORAGE — deliberately NOT discounts:global. That doc is served to
 * every visitor by /api/discounts and /api/bootstrap, so anything in it
 * (codes, guest names, mobile numbers) would be publicly readable. Cards
 * live in their own private doc, `referrals:global`, which no public
 * endpoint returns. As with every other doc, the permanent record is a
 * message in the admin Telegram chat (see store.js).
 *
 * This module has no HTTP handlers and does not import booking.js —
 * booking.js imports THIS file, so the public endpoints live in
 * referral-api.js to keep the import graph free of cycles.
 */

import { getDoc, saveDoc, SITE_LABELS } from "./store.js";
import { tg, tgSendMessage } from "./telegram.js";
import { claimOnce, getClaim, releaseClaim } from "./status-store.js";

const DOC_KEY = "referrals:global";
const claimKey = (code) => `refclaim:${code}`;

// Cards that are finished (used or expired) are pruned from the doc
// after this long, so the Telegram-stored record doesn't grow forever.
const PRUNE_AFTER_DAYS = 90;

// ---------------------------------------------------------------------
// Small normalisers
// ---------------------------------------------------------------------

export function normalizeCode(code) {
  return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Digits only, last 10 — so "+91 98765 43210", "098765-43210" and
// "9876543210" all compare equal. Returns "" if fewer than 10 digits.
export function normalizeMobile(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

export function maskMobile(mobile) {
  const m = normalizeMobile(mobile);
  return m ? `•••••${m.slice(-4)}` : "";
}

function nameTokens(name) {
  return String(name || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

// Lenient on purpose (the mobile number is the real lock): the visitor
// only has to share at least one whole word with the guest name on the
// card, so "Priya S" or "Sharma Priya" still match "Priya Sharma".
export function namesMatch(cardName, visitorName) {
  const card = nameTokens(cardName);
  const visitor = new Set(nameTokens(visitorName));
  if (!card.length) return true; // card has no usable name to compare
  return card.some((t) => visitor.has(t));
}

function slugifyName(name) {
  const clean = String(name || "guest")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  return clean || "GUEST";
}

// ---------------------------------------------------------------------
// The discount maths — ONE definition, used by the website (a copy of
// this exact formula lives in each site's app.js) and re-checked by
// the backend on submit.
//
//   discountable  = subtotal − excluded   (excluded = the 4x4 jeep, unless
//                                          the admin included it on the card)
//   coveredPeople = min(people on the card, people on the booking)
//   base          = discountable × coveredPeople ÷ people on the booking
//   percent card  → round(base × percent ÷ 100)
//   flat card     → min(flat ₹, round(base))
//
// so a 1-person card on a 3-person booking only ever discounts one
// person's share of the bill; the other two are charged normally.
// ---------------------------------------------------------------------
export function computeReferralDiscount({ percent, flat, cardPeople, subtotal, persons, excluded }) {
  const total = Number(persons) || 0;
  const sub = Number(subtotal) || 0;
  if (total < 1 || sub <= 0) return { discount: 0, coveredPeople: 0 };
  const coveredPeople = Math.min(Math.max(1, Number(cardPeople) || 1), total);
  // The 4x4 jeep is a per-group charge, so it comes off BEFORE the per-guest
  // share is worked out (never more than the subtotal itself).
  const skip = Math.min(Math.max(0, Number(excluded) || 0), sub);
  const base = ((sub - skip) * coveredPeople) / total;
  let discount = 0;
  if (percent) discount = Math.round((base * percent) / 100);
  else if (flat) discount = Math.min(Number(flat), Math.round(base));
  discount = Math.max(0, Math.min(discount, sub));
  return { discount, coveredPeople };
}

// ---------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------

async function loadCodes(env) {
  const doc = await getDoc(env, DOC_KEY, {});
  return { doc, codes: { ...(doc.codes || {}) } };
}

// Generates a short, memorable, guaranteed-unused code like
// "PRIYA482" — base is the guest's name, suffix avoids collisions.
export async function generateUniqueCode(env, name) {
  const { codes } = await loadCodes(env);
  const base = slugifyName(name);
  let code;
  let tries = 0;
  do {
    const suffix = Math.floor(100 + Math.random() * 900); // 3 digits
    code = `${base}${suffix}`;
    tries++;
  } while (codes[code] && tries < 40);
  return code;
}

// Builds a public URL to the site's logo, for attaching to the card.
// Telegram's sendPhoto accepts a plain URL, so no upload/file_id
// dance is needed as long as SITE_BASE_URL is set (same env var the
// bot already uses for "👁️ Live site links" — see sendPreviewLinks).
export function siteLogoUrl(env, site) {
  const base = (env.SITE_BASE_URL || "https://your-site.example.com").replace(/\/$/, "");
  if (site === "root") return `${base}/logo.png`;
  return `${base}/${site}/logo.png`;
}

/**
 * Creates a referral card and returns everything needed to render it.
 *
 * @param {object} p
 * @param {string} p.site            "krem-chympe" | "wilderness-expedition"
 * @param {string} p.packageLabel    package name shown on the card
 * @param {string} [p.packageKey]    "sharedTour" | "privatePackage" (the site's own package key)
 * @param {string} p.visitorName
 * @param {number} p.people          how many guests this card covers
 * @param {string} p.mobile          guest's mobile number (any format)
 * @param {number} p.originalAmount  full price for those guests, before the code, ₹
 * @param {"percent"|"flat"} p.discountType
 * @param {number} p.discountValue   percent (0-100) or flat ₹ amount
 * @param {Array<{label:string, amount:number, included:boolean}>} [p.extras]
 *        Named parts of originalAmount (4x4, guide, food, activities,
 *        facilities, or anything the admin typed) that are LEFT OUT of the
 *        discount unless included is true. Amounts are clamped to
 *        originalAmount as a group.
 */
export async function createReferralCode(env, p) {
  const { site, packageLabel, visitorName, people, mobile, originalAmount, discountType, discountValue } = p;
  // Named parts of the price (4x4, guide, food, activities, facilities, ...)
  // that are left out of the discount unless the admin ticked "include".
  // Amounts are rounded, floored at 0, and clamped as a GROUP so they can
  // never add up to more than the price itself.
  const extras = normalizeExtras(p.extras, originalAmount);
  const excludedTotal = extras.filter((e) => !e.included).reduce((sum, e) => sum + e.amount, 0);
  const discountable = Math.max(0, originalAmount - excludedTotal);

  const { doc, codes } = await loadCodes(env);
  pruneFinished(codes);
  const code = await generateUniqueCode(env, visitorName);

  const percent = discountType === "percent" ? discountValue : undefined;
  const flat = discountType === "flat" ? discountValue : undefined;

  let amountDue = originalAmount;
  if (percent) amountDue = originalAmount - Math.round((discountable * percent) / 100);
  if (flat) amountDue = Math.max(0, originalAmount - Math.min(flat, discountable));

  const guests = Math.max(1, Math.round(Number(people) || 1));

  codes[code] = {
    active: true,
    ...(percent ? { percent } : {}),
    ...(flat ? { flat } : {}),
    site,
    packageLabel: packageLabel || "",
    packageKey: p.packageKey || "",
    visitorName,
    people: guests,
    mobile: normalizeMobile(mobile),
    originalAmount,
    amountDue,
    extras,
    createdAt: new Date().toISOString(),
    redeemed: false,
  };

  await saveDoc(env, DOC_KEY, { ...doc, codes }, {
    logChange: `🎁 Created referral code ${code} for ${visitorName} (${SITE_LABELS[site] || site}, ${guests} guest${guests === 1 ? "" : "s"})`,
  });

  return {
    code,
    site,
    packageLabel,
    visitorName,
    people: guests,
    mobile: normalizeMobile(mobile),
    originalAmount,
    percent: percent || null,
    flat: flat || null,
    amountDue,
    extras,
  };
}

// Rounds each amount, floors at 0, and clamps the GROUP total to `cap` by
// scaling every amount down proportionally if the admin's numbers add up to
// more than the price itself. Unknown/blank labels are kept as typed.
function normalizeExtras(raw, cap) {
  const list = Array.isArray(raw) ? raw : [];
  const cleaned = list
    .map((e) => ({
      label: String((e && e.label) || "").trim().slice(0, 40),
      amount: Math.max(0, Math.round(Number(e && e.amount) || 0)),
      included: e && e.included === true,
    }))
    .filter((e) => e.label && e.amount > 0);
  const total = cleaned.reduce((sum, e) => sum + e.amount, 0);
  if (total > cap && total > 0) {
    const scale = cap / total;
    for (const e of cleaned) e.amount = Math.round(e.amount * scale);
  }
  return cleaned;
}

function pruneFinished(codes) {
  const cutoff = Date.now() - PRUNE_AFTER_DAYS * 86400000;
  for (const [code, c] of Object.entries(codes)) {
    const finished = c.redeemed || c.active === false || (c.expiresAt && new Date(c.expiresAt).getTime() < Date.now());
    const when = new Date(c.redeemedAt || c.createdAt || 0).getTime();
    if (finished && when && when < cutoff) delete codes[code];
  }
}

// ---------------------------------------------------------------------
// The card itself (what the admin forwards on WhatsApp)
// ---------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildReferralCardCaption(r) {
  const savings = r.originalAmount - r.amountDue;
  const discountLine = r.percent ? `${r.percent}% OFF` : `₹${r.flat} OFF`;
  const guestsLine = `${r.people} guest${r.people === 1 ? "" : "s"}`;
  return (
    `🎁 <b>Referral Offer</b>\n` +
    `<b>${SITE_LABELS[r.site] || r.site}</b>${r.packageLabel ? " — " + escapeHtml(r.packageLabel) : ""}\n\n` +
    `Guest: <b>${escapeHtml(r.visitorName)}</b> · ${guestsLine}\n` +
    `Package price: ₹${r.originalAmount}\n` +
    (Array.isArray(r.extras) && r.extras.length
      ? r.extras.map((e) =>
          `${escapeHtml(e.label)} (₹${e.amount}): ${e.included ? "included in the discount" : "NOT discounted"}`
        ).join("\n") + "\n"
      : "") +
    `Discount: ${discountLine} (save ₹${savings})\n` +
    `Amount to pay: <b>₹${r.amountDue}</b>\n\n` +
    `Referral code: <code>${r.code}</code>\n\n` +
    `Book with the mobile (WhatsApp) number ending <b>${normalizeMobile(r.mobile).slice(-4)}</b> to unlock this discount. ` +
    `Valid for ${guestsLine} only, and the code works once.`
  );
}

// Sends the finished card to the admin chat: the site logo as a photo,
// with the offer details as the caption. Falls back to a plain text
// message if the logo can't be fetched/sent (bad SITE_BASE_URL, logo
// not public yet, etc.) — the code itself must never be lost over a
// missing image.
export async function sendReferralCard(env, chatId, referral) {
  const caption = buildReferralCardCaption(referral);
  const logo = siteLogoUrl(env, referral.site);
  const res = await tg(env, "sendPhoto", { chat_id: chatId, photo: logo, caption, parse_mode: "HTML" });
  if (!res.ok) {
    await tgSendMessage(env, chatId, caption);
  }
}

// ---------------------------------------------------------------------
// Lookups used by the website
// ---------------------------------------------------------------------

// Is this card still usable? (active, not expired, not already
// redeemed). The Durable Object claim is the source of truth for
// "redeemed" — the doc flag is only a mirror for the admin's record —
// so a code is dead the instant a booking claims it, even if the doc
// mirror hasn't been written yet.
async function usability(env, code, entry) {
  if (!entry || entry.active === false) return "invalid";
  if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) return "invalid";
  if (entry.redeemed) return "used";
  const holder = await getClaim(env, claimKey(code));
  if (holder) return "used";
  return "ok";
}

/**
 * Should the booking form show the referral box for this visitor?
 * True only when a live card exists for this site whose mobile number
 * (and, leniently, name) match what the visitor typed. Returns just a
 * boolean — never the code, name or amounts.
 */
export async function isEligible(env, { site, mobile, name }) {
  const m = normalizeMobile(mobile);
  if (!m) return false;
  const { codes } = await loadCodes(env);
  for (const [code, entry] of Object.entries(codes)) {
    if (entry.site !== site || entry.mobile !== m) continue;
    if (!namesMatch(entry.visitorName, name)) continue;
    if ((await usability(env, code, entry)) === "ok") return true;
  }
  return false;
}

/**
 * Validates a typed code against the visitor's details.
 * Returns { valid: true, code, entry } or { valid: false, reason }.
 * The mobile number is checked BEFORE anything about the code's state
 * is revealed, so guessing codes without the matching mobile learns
 * nothing (an unknown code and a wrong-mobile code look identical).
 */
export async function validateForVisitor(env, { site, code, mobile, name }) {
  const c = normalizeCode(code);
  if (!c) return { valid: false, reason: "invalid" };
  const { codes } = await loadCodes(env);
  const entry = codes[c];
  const m = normalizeMobile(mobile);
  if (!entry || entry.site !== site || !m || entry.mobile !== m || !namesMatch(entry.visitorName, name)) {
    return { valid: false, reason: "invalid" };
  }
  const state = await usability(env, c, entry);
  if (state !== "ok") return { valid: false, reason: state };
  return { valid: true, code: c, entry };
}

// ---------------------------------------------------------------------
// Redeeming (called from booking.js#handleSubmit)
// ---------------------------------------------------------------------

/**
 * Re-validates the code the booking claims to use, re-checks that the
 * discount it claims is one this card can actually give, then claims
 * the code atomically. Nothing is claimed unless everything checks out.
 *
 * @returns {{ok:true, referral:null}                       no code on this booking
 *          |{ok:true, referral:object}                      claimed
 *          |{ok:false, status:number, referralError:string, error:string}}
 */
export async function verifyAndClaimForBooking(env, { siteId, bookingId, data }) {
  const code = normalizeCode(data && data.referralCode);
  if (!code) return { ok: true, referral: null };

  const v = await validateForVisitor(env, { site: siteId, code, mobile: data.whatsapp, name: data.name });
  if (!v.valid) {
    return v.reason === "used"
      ? { ok: false, status: 409, referralError: "used", error: "This referral code has already been used." }
      : { ok: false, status: 400, referralError: "invalid", error: "This referral code isn't valid for the details on this booking." };
  }

  const entry = v.entry;
  const persons = Number(data.referralPersons);
  const subtotal = Number(data.referralSubtotal);
  if (!(persons >= 1) || !(subtotal >= 0)) {
    return { ok: false, status: 400, referralError: "invalid", error: "Referral details are missing from this booking." };
  }

  // How much of the subtotal is left out of the discount — worked out
  // ENTIRELY from the card the admin made (entry.extras), never from
  // anything the visitor's browser sends. Amounts on the card are for the
  // guest count/price the admin typed, so this can be a slight approximation
  // if the visitor's actual booking differs, but it's never guest-controlled.
  const excluded = Math.min(
    (entry.extras || []).filter((e) => !e.included).reduce((sum, e) => sum + e.amount, 0),
    subtotal
  );

  const { discount, coveredPeople } = computeReferralDiscount({
    percent: entry.percent,
    flat: entry.flat,
    cardPeople: entry.people,
    subtotal,
    persons,
    excluded,
  });
  // The browser shows the visitor their discounted total, so its
  // number must never be bigger than what this card is worth.
  if (Number(data.referralDiscount || 0) > discount + 1) {
    return { ok: false, status: 400, referralError: "mismatch", error: "The referral discount on this booking doesn't match the code." };
  }

  const claim = await claimOnce(env, claimKey(code), bookingId);
  if (!claim.claimed) {
    return { ok: false, status: 409, referralError: "used", error: "This referral code has already been used." };
  }

  return {
    ok: true,
    referral: {
      code,
      discount,
      coveredPeople,
      totalPersons: persons,
      cardPeople: entry.people,
      guestName: entry.visitorName,
      excluded,
    },
  };
}

// Gives the code back — ONLY for a booking that never reached anyone
// (Telegram send failed, no chat configured). Never called for a
// rejected booking; a rejection leaves the code spent.
export async function releaseReferralClaim(env, code, bookingId) {
  if (!code) return;
  await releaseClaim(env, claimKey(code), bookingId).catch(() => {});
}

// Mirrors "used" onto the card in the admin's permanent record. Best
// effort and non-blocking — the Durable Object claim is what actually
// enforces single use, this is just so the admin can see it.
export async function markRedeemedInDoc(env, code, bookingId, discount) {
  try {
    const { doc, codes } = await loadCodes(env);
    if (!codes[code]) return;
    codes[code] = {
      ...codes[code],
      redeemed: true,
      redeemedBy: bookingId,
      redeemedAt: new Date().toISOString(),
      discountGiven: discount,
    };
    await saveDoc(env, DOC_KEY, { ...doc, codes }, {
      logChange: `🎁 Referral code ${code} was used on booking ${bookingId} (₹${discount} off) — now expired`,
    });
  } catch (e) {
    /* mirror only — never let it affect the booking */
  }
}

// One-line human text, reused by the Telegram booking message and the
// Confirm/Reject badges so they always say the same thing.
export function referralSummaryLine(r) {
  if (!r) return "";
  const who =
    r.totalPersons > r.coveredPeople
      ? ` (applied to ${r.coveredPeople} of ${r.totalPersons} guests — the rest at regular price)`
      : "";
  const skipped = r.excluded > 0 ? ` (₹${r.excluded} of extras not discounted)` : "";
  return `Referral code ${r.code} used — ₹${r.discount} discount${who}${skipped}`;
}
