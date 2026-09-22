/**
 * referral-api.js — the two public endpoints the booking forms call.
 * (Kept apart from referrals.js because booking.js imports that file,
 * and these handlers need booking.js's json() helper — this way the
 * import graph has no cycle.)
 *
 *   POST /api/referral-check    { site, mobile, name }
 *        -> { ok, eligible }
 *        Called when the visitor reaches the pricing page. The
 *        "Referral / Discount Code" box is only shown if eligible is
 *        true — i.e. the mobile number + name they filled in match a
 *        live referral card. Returns nothing but the boolean.
 *
 *   POST /api/referral-validate { site, code, mobile, name }
 *        -> { ok, valid, code, percent|flat, cardPeople, extras }
 *           or { ok, valid:false, reason: "invalid" | "used" }
 *        Called when the visitor taps Apply.
 *
 * Both are POST (not GET) so the visitor's mobile number never ends up
 * in a URL / access log. Both are consent-gated in the browser
 * (booking-bridge.js) since they carry the visitor's details.
 */

import { json } from "./booking.js";
import { isValidSite } from "./store.js";
import { isEligible, validateForVisitor } from "./referrals.js";

async function readBody(request) {
  try {
    return await request.json();
  } catch (e) {
    return null;
  }
}

export async function handleReferralCheck(request, env) {
  const body = await readBody(request);
  if (!body || !isValidSite(body.site)) return json({ ok: false, eligible: false, error: "bad request" }, env, 400);
  const eligible = await isEligible(env, { site: body.site, mobile: body.mobile, name: body.name });
  return json({ ok: true, eligible }, env);
}

export async function handleReferralValidate(request, env) {
  const body = await readBody(request);
  if (!body || !isValidSite(body.site) || !body.code) return json({ ok: false, valid: false, error: "bad request" }, env, 400);

  const v = await validateForVisitor(env, { site: body.site, code: body.code, mobile: body.mobile, name: body.name });
  if (!v.valid) return json({ ok: true, valid: false, reason: v.reason }, env);

  return json(
    {
      ok: true,
      valid: true,
      code: v.code,
      percent: v.entry.percent || null,
      flat: v.entry.flat || null,
      cardPeople: v.entry.people || 1,
      extras: Array.isArray(v.entry.extras) ? v.entry.extras : [],
    },
    env
  );
}
