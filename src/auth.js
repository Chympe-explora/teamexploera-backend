/**
 * auth.js — password login/lock for the admin bot and every guide's own
 * Telegram dashboard.
 *
 * Storage (plain KV, same style as guides.js — this is small, per-account
 * state, not content that belongs in the permanent Telegram-log doc
 * pattern):
 *
 *   auth:admin:<telegramUserId>  -> { phone, password, isDefault, locked }
 *   auth:guide:<guideId>         -> { password, isDefault, locked }
 *
 * `password` is plain text on purpose — Telegram is already the entire
 * trust boundary here (only whoever is chatting as that Telegram
 * account can ever be asked for it), and hashing would need a secret we
 * don't otherwise have anywhere in this Worker. Nothing here is meant to
 * resist a determined attacker; it's a lock on the office door, not a
 * bank vault.
 *
 * DEFAULT PASSWORD RULE (admin only): an admin's password defaults to
 * their own registered mobile number until they set a custom one via
 * 🔑 Change Password. Guides do NOT have this — see the password-reset
 * section further down for how a guide gets/recovers a password.
 * `isDefault` tracks whether an account's current password is still
 * that auto-assigned admin default vs a custom one chosen deliberately.
 *
 * IMPORTANT — who gets told the default-password rule: the admin main
 * menu is allowed to say outright "your default password is your
 * mobile number" (see sendMainMenu in telegram-bot.js). This has never
 * applied to guides and still doesn't — a guide only ever sees a plain
 * "enter your password" prompt, or the reset flow below.
 */

function authKey(kind, id) {
  return `auth:${kind}:${id}`;
}

export async function getAuth(env, kind, id) {
  const raw = await env.BOOKINGS.get(authKey(kind, id));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveAuth(env, kind, id, record) {
  await env.BOOKINGS.put(authKey(kind, id), JSON.stringify(record));
}

export async function hasPassword(env, kind, id) {
  const auth = await getAuth(env, kind, id);
  return !!(auth && auth.password);
}

export async function isLocked(env, kind, id) {
  const auth = await getAuth(env, kind, id);
  return !!(auth && auth.locked);
}

// NOTE: guides no longer get a default password derived from their
// WhatsApp number — see the password-reset flow below instead. A
// guide's very first password is only ever set deliberately, via
// 🔑 Set Password on their own dashboard, or one of the two recovery
// paths below.

// Call once, the first time a real admin's Telegram account is seen
// with no registered mobile number yet (see the "adminphone" onboarding
// step in telegram-bot.js). Same default-adoption rule as guides.
export async function setAdminPhone(env, userId, phone) {
  let auth = await getAuth(env, "admin", userId);
  if (!auth) {
    auth = { phone, password: phone, isDefault: true, locked: false };
  } else {
    auth.phone = phone;
    if (auth.isDefault !== false) auth.password = phone;
  }
  await saveAuth(env, "admin", userId, auth);
  return auth;
}

export async function getAdminPhone(env, userId) {
  const auth = await getAuth(env, "admin", userId);
  return auth ? auth.phone || null : null;
}

// Sets a custom password the account chose for itself — from this point
// on it stops tracking phone-number changes (isDefault: false).
export async function setCustomPassword(env, kind, id, newPassword) {
  let auth = await getAuth(env, kind, id);
  if (!auth) auth = { locked: false };
  auth.password = newPassword;
  auth.isDefault = false;
  // Setting a new password is always how someone gets back in — clear
  // the lock and any pending reset request/approval in the same step.
  auth.locked = false;
  delete auth.resetRequestedAt;
  auth.resetAllowed = false;
  await saveAuth(env, kind, id, auth);
}

// ---------------------------------------------------------------------
// GUIDE PASSWORD RESET — replaces the old "mobile number is the default
// password" scheme entirely. A guide with no password (or a forgotten
// one) recovers one of two ways:
//   1. Request → admin taps Allow → guide gets a "Reset Password Now"
//      button (requestGuideReset / allowGuideReset below).
//   2. Admin hands the guide a one-time code out of band (phone call,
//      WhatsApp) generated from the guide's own admin detail screen,
//      which the guide pastes into the bot (generateGuideResetCode /
//      redeemGuideResetCode below).
// Both end the same way — the guide sends a plain-text new password —
// handled by setCustomPassword above, which also lifts the lock.
// ---------------------------------------------------------------------

export async function requestGuideReset(env, guideId) {
  let auth = await getAuth(env, "guide", guideId);
  if (!auth) auth = { password: null, locked: false };
  auth.resetRequestedAt = Date.now();
  auth.resetAllowed = false;
  await saveAuth(env, "guide", guideId, auth);
}

export async function allowGuideReset(env, guideId) {
  let auth = await getAuth(env, "guide", guideId);
  if (!auth) auth = { password: null, locked: false };
  auth.resetAllowed = true;
  await saveAuth(env, "guide", guideId, auth);
}

function randomResetCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — easy to read aloud over a call
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// 24h validity, one-time use — generated from a guide's admin detail
// screen ("🔑 Generate Password Reset Code") and read out to them.
export async function generateGuideResetCode(env, guideId) {
  const code = randomResetCode();
  await env.BOOKINGS.put(`pwresetcode:${code}`, String(guideId), { expirationTtl: 60 * 60 * 24 });
  return code;
}

export async function redeemGuideResetCode(env, code) {
  const key = `pwresetcode:${String(code).trim().toUpperCase()}`;
  const guideId = await env.BOOKINGS.get(key);
  if (!guideId) return null;
  await env.BOOKINGS.delete(key);
  return guideId;
}

// Refuses to lock an account with no password on file yet — otherwise
// logging out would be a one-way door with no way back in.
export async function lockAccount(env, kind, id) {
  const auth = await getAuth(env, kind, id);
  if (!auth || !auth.password) return false;
  auth.locked = true;
  await saveAuth(env, kind, id, auth);
  return true;
}

export async function tryUnlock(env, kind, id, attempt) {
  const auth = await getAuth(env, kind, id);
  if (!auth || !auth.password) return false;
  if (String(attempt || "").trim() !== String(auth.password).trim()) return false;
  auth.locked = false;
  await saveAuth(env, kind, id, auth);
  return true;
}
