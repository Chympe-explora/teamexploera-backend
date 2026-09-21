/**
 * loyalty-api.js
 * -----------------------------------------------------------------------
 * API endpoints for loyalty and referral program
 * 
 * Endpoints:
 * GET    /api/loyalty/{guestId}              - Get loyalty profile
 * POST   /api/loyalty/{guestId}/referral     - Get or create referral code
 * POST   /api/loyalty/apply-code             - Apply referral code
 * POST   /api/loyalty/redeem-points          - Redeem points for discount
 * GET    /api/loyalty/leaderboard            - Get top referrers
 * GET    /api/loyalty/discounts/{guestId}    - Get available discounts
 * POST   /api/loyalty/validate-code          - Validate discount code
 * POST   /api/loyalty/record-booking         - Record booking for loyalty
 * -----------------------------------------------------------------------
 */

import { json, corsHeaders } from "./booking.js";
import {
  createReferralCode,
  getReferralCode,
  applyReferralCode,
  getGuestLoyalty,
  getGuestLoyaltySummary,
  recordBookingForLoyalty,
  redeemPoints,
  validateDiscountCode,
  applyDiscountCode,
  getAvailableDiscounts,
  getLeaderboard,
  getTierBenefits,
} from "./loyalty-referral.js";

/**
 * GET /api/loyalty/{guestId}
 * Get complete loyalty profile for guest
 */
export async function handleGetLoyaltyProfile(request, env, guestId) {
  try {
    if (!guestId) {
      return json({ ok: false, error: "guestId required" }, env, 400);
    }

    const summary = await getGuestLoyaltySummary(env, guestId);
    if (!summary) {
      return json({ ok: false, error: "Guest not found" }, env, 404);
    }

    return json({ ok: true, loyalty: summary }, env);
  } catch (e) {
    console.error("Get loyalty profile error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * POST /api/loyalty/{guestId}/referral
 * Get or create referral code for guest
 */
export async function handleGetReferralCode(request, env, guestId) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "POST required" }, env, 405);
  }

  try {
    const { guestName, guestEmail } = await request.json();

    if (!guestId || !guestName) {
      return json(
        { ok: false, error: "guestId and guestName required" },
        env,
        400
      );
    }

    // Check if already has code
    let code = await getReferralCode(env, guestId);

    if (!code) {
      // Create new code
      code = await createReferralCode(env, guestId, guestName, guestEmail);
    }

    if (!code) {
      return json(
        { ok: false, error: "Failed to create referral code" },
        env,
        500
      );
    }

    return json(
      {
        ok: true,
        code: code.code,
        referralLink: `https://your-site.com/?ref=${code.code}`,
        usage: code.used,
      },
      env
    );
  } catch (e) {
    console.error("Get referral code error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * POST /api/loyalty/apply-code
 * Apply referral code to booking
 */
export async function handleApplyReferralCode(request, env) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "POST required" }, env, 405);
  }

  try {
    const { bookingId, referralCode, bookingCost } = await request.json();

    if (!bookingId || !referralCode || !bookingCost) {
      return json(
        {
          ok: false,
          error: "bookingId, referralCode, and bookingCost required",
        },
        env,
        400
      );
    }

    const result = await applyReferralCode(env, bookingId, referralCode, bookingCost);

    if (!result.valid) {
      return json({ ok: false, error: result.error }, env, 400);
    }

    return json({ ok: true, discount: result }, env);
  } catch (e) {
    console.error("Apply referral code error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * POST /api/loyalty/{guestId}/redeem-points
 * Redeem loyalty points for discount code
 */
export async function handleRedeemPoints(request, env, guestId) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "POST required" }, env, 405);
  }

  try {
    const { points } = await request.json();

    if (!guestId || !points) {
      return json(
        { ok: false, error: "guestId and points required" },
        env,
        400
      );
    }

    const result = await redeemPoints(env, guestId, points);

    if (!result.valid) {
      return json({ ok: false, error: result.error }, env, 400);
    }

    return json({ ok: true, discount: result }, env);
  } catch (e) {
    console.error("Redeem points error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * GET /api/loyalty/leaderboard
 * Get top 100 referrers leaderboard
 */
export async function handleGetLeaderboard(request, env) {
  try {
    const leaderboard = await getLeaderboard(env);
    return json({ ok: true, leaderboard }, env);
  } catch (e) {
    console.error("Get leaderboard error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * GET /api/loyalty/discounts/{guestId}
 * Get all available discounts for guest
 */
export async function handleGetAvailableDiscounts(request, env, guestId) {
  try {
    if (!guestId) {
      return json({ ok: false, error: "guestId required" }, env, 400);
    }

    const discounts = await getAvailableDiscounts(env, guestId);
    return json({ ok: true, discounts }, env);
  } catch (e) {
    console.error("Get available discounts error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * POST /api/loyalty/validate-code
 * Validate a discount code
 */
export async function handleValidateDiscountCode(request, env) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "POST required" }, env, 405);
  }

  try {
    const { code } = await request.json();

    if (!code) {
      return json({ ok: false, error: "code required" }, env, 400);
    }

    const result = await validateDiscountCode(env, code);

    if (!result.valid) {
      return json({ ok: false, error: result.error }, env, 400);
    }

    return json({ ok: true, discount: result }, env);
  } catch (e) {
    console.error("Validate discount code error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * POST /api/loyalty/apply-discount
 * Apply discount code to booking
 */
export async function handleApplyDiscountCode(request, env) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "POST required" }, env, 405);
  }

  try {
    const { bookingId, code } = await request.json();

    if (!bookingId || !code) {
      return json(
        { ok: false, error: "bookingId and code required" },
        env,
        400
      );
    }

    const result = await applyDiscountCode(env, bookingId, code);

    if (!result.valid) {
      return json({ ok: false, error: result.error }, env, 400);
    }

    return json({ ok: true, applied: result }, env);
  } catch (e) {
    console.error("Apply discount code error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * POST /api/loyalty/record-booking
 * Record booking for loyalty points
 */
export async function handleRecordBookingForLoyalty(request, env) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "POST required" }, env, 405);
  }

  try {
    const { guestId, bookingId, bookingCost } = await request.json();

    if (!guestId || !bookingId || !bookingCost) {
      return json(
        {
          ok: false,
          error: "guestId, bookingId, and bookingCost required",
        },
        env,
        400
      );
    }

    const loyalty = await recordBookingForLoyalty(env, guestId, bookingId, bookingCost);

    if (!loyalty) {
      return json(
        { ok: false, error: "Failed to record booking" },
        env,
        500
      );
    }

    const points = Math.floor(bookingCost / 100);

    return json(
      {
        ok: true,
        message: `Booking recorded! You earned ${points} loyalty points.`,
        loyalty: {
          totalSpent: loyalty.totalSpent,
          points: loyalty.points,
          tier: loyalty.tier,
        },
      },
      env
    );
  } catch (e) {
    console.error("Record booking for loyalty error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * GET /api/loyalty/tiers
 * Get all tier information
 */
export async function handleGetTierInfo(request, env) {
  try {
    const tiers = ["bronze", "silver", "gold", "platinum"].map((tier) => ({
      tier,
      ...getTierBenefits(tier),
    }));

    return json({ ok: true, tiers }, env);
  } catch (e) {
    console.error("Get tier info error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * GET /api/loyalty/referral-link
 * Get referral link with code in URL params
 */
export async function handleGetReferralLink(request, env) {
  try {
    const code = new URL(request.url).searchParams.get("code");

    if (!code) {
      return json({ ok: false, error: "code parameter required" }, env, 400);
    }

    // Verify code exists
    const codeRaw = await env.BOOKINGS.get(`referral-code:${code}`);
    if (!codeRaw) {
      return json({ ok: false, error: "Invalid referral code" }, env, 404);
    }

    const codeData = JSON.parse(codeRaw);

    return json(
      {
        ok: true,
        referrer: codeData.guestName,
        referralCode: code,
        bonus: "10% discount on your first booking!",
      },
      env
    );
  } catch (e) {
    console.error("Get referral link error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}
