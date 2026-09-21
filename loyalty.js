/**
 * loyalty.js
 * -----------------------------------------------------------------------
 * Loyalty & Referral Program System
 * 
 * Features:
 * 1. Generate unique referral codes per user
 * 2. Track referral usage and conversions
 * 3. Apply discounts to referred bookings
 * 4. Loyalty points on every booking
 * 5. Redeem points for discounts
 * 6. Leaderboard (top referrers)
 * 7. Tier-based rewards (Bronze, Silver, Gold, Platinum)
 * 8. Referral analytics
 * 
 * Data stored in KV:
 *   referral-code:{code} = { code, createdBy, createdAt, usageCount }
 *   referral-user:{email} = { code, createdAt, referralCount, totalEarnings }
 *   loyalty-points:{email} = { points, lastUpdated, transactions }
 *   referral-tracking:{code}:{bookingId} = { bookingId, amount, discount, date }
 * -----------------------------------------------------------------------
 */

/**
 * Generate unique referral code
 * Format: USER_{timestamp}_{random}
 * Example: USER_abc123_def456
 */
export function generateReferralCode(email) {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `REF_${timestamp}_${random}`;
}

/**
 * Create referral code for user
 */
export async function createReferralCode(env, email, fullName = "") {
  try {
    const code = generateReferralCode(email);
    
    // Store code info
    const codeData = {
      code,
      createdBy: email,
      createdByName: fullName,
      createdAt: Date.now(),
      usageCount: 0,
      totalRewards: 0
    };
    
    await env.BOOKINGS.put(
      `referral-code:${code}`,
      JSON.stringify(codeData),
      { expirationTtl: 60 * 60 * 24 * 365 * 5 } // 5 years
    );
    
    // Store user's referral data
    const userData = {
      email,
      fullName,
      code,
      createdAt: Date.now(),
      referralCount: 0,
      totalEarnings: 0,
      tier: "Bronze" // Starting tier
    };
    
    await env.BOOKINGS.put(
      `referral-user:${email}`,
      JSON.stringify(userData)
    );
    
    return codeData;
  } catch (e) {
    console.error("Error creating referral code:", e);
    return null;
  }
}

/**
 * Get referral code for user
 */
export async function getUserReferralCode(env, email) {
  try {
    const raw = await env.BOOKINGS.get(`referral-user:${email}`);
    if (!raw) return null;
    
    const userData = JSON.parse(raw);
    return userData.code;
  } catch (e) {
    return null;
  }
}

/**
 * Validate and apply referral code to booking
 */
export async function applyReferralCode(env, referralCode, bookingId, bookingAmount, referredEmail) {
  try {
    if (!referralCode) return { valid: false, discount: 0 };
    
    // Check if code exists
    const codeRaw = await env.BOOKINGS.get(`referral-code:${referralCode}`);
    if (!codeRaw) {
      return { valid: false, error: "Invalid referral code" };
    }
    
    const codeData = JSON.parse(codeRaw);
    
    // Don't allow self-referrals
    if (codeData.createdBy === referredEmail) {
      return { valid: false, error: "Cannot use your own referral code" };
    }
    
    // Calculate discount based on booking amount
    // First booking: 15% discount
    // Subsequent: 10% discount
    const isFirstBooking = await isUserFirstBooking(env, referredEmail);
    const discountPercent = isFirstBooking ? 15 : 10;
    const discountAmount = (bookingAmount * discountPercent) / 100;
    
    return {
      valid: true,
      discountPercent,
      discountAmount,
      finalAmount: bookingAmount - discountAmount
    };
  } catch (e) {
    console.error("Error applying referral code:", e);
    return { valid: false, error: e.message };
  }
}

/**
 * Record referral conversion
 */
export async function recordReferralConversion(env, referralCode, bookingId, bookingAmount, discountAmount, referredEmail) {
  try {
    // Get code data
    const codeRaw = await env.BOOKINGS.get(`referral-code:${referralCode}`);
    if (!codeRaw) return false;
    
    const codeData = JSON.parse(codeRaw);
    const referrerEmail = codeData.createdBy;
    
    // Update code usage count
    codeData.usageCount++;
    codeData.totalRewards += discountAmount;
    await env.BOOKINGS.put(`referral-code:${referralCode}`, JSON.stringify(codeData));
    
    // Record tracking
    const trackingData = {
      bookingId,
      referrerEmail,
      referredEmail,
      bookingAmount,
      discountAmount,
      referrerEarnings: discountAmount * 0.2, // 20% of discount goes to referrer
      date: Date.now()
    };
    
    await env.BOOKINGS.put(
      `referral-tracking:${referralCode}:${bookingId}`,
      JSON.stringify(trackingData)
    );
    
    // Update referrer's loyalty account
    await addLoyaltyPoints(env, referrerEmail, Math.round(discountAmount * 0.2), "referral_conversion");
    
    // Update referred user's loyalty account
    await addLoyaltyPoints(env, referredEmail, Math.round(bookingAmount * 0.05), "first_booking_bonus");
    
    // Update referrer stats
    const referrerRaw = await env.BOOKINGS.get(`referral-user:${referrerEmail}`);
    if (referrerRaw) {
      const referrerData = JSON.parse(referrerRaw);
      referrerData.referralCount++;
      referrerData.totalEarnings += trackingData.referrerEarnings;
      referrerData.tier = calculateTier(referrerData.referralCount);
      await env.BOOKINGS.put(`referral-user:${referrerEmail}`, JSON.stringify(referrerData));
    }
    
    return trackingData;
  } catch (e) {
    console.error("Error recording referral conversion:", e);
    return false;
  }
}

/**
 * Add loyalty points to user
 */
export async function addLoyaltyPoints(env, email, points, reason = "booking") {
  try {
    const kvKey = `loyalty-points:${email}`;
    const raw = await env.BOOKINGS.get(kvKey);
    
    let userData = raw
      ? JSON.parse(raw)
      : { email, points: 0, transactions: [] };
    
    userData.points += points;
    userData.lastUpdated = Date.now();
    
    // Record transaction
    userData.transactions.push({
      points,
      reason,
      date: Date.now(),
      balance: userData.points
    });
    
    // Keep only last 100 transactions
    if (userData.transactions.length > 100) {
      userData.transactions = userData.transactions.slice(-100);
    }
    
    await env.BOOKINGS.put(kvKey, JSON.stringify(userData));
    
    return userData;
  } catch (e) {
    console.error("Error adding loyalty points:", e);
    return null;
  }
}

/**
 * Get loyalty points for user
 */
export async function getLoyaltyPoints(env, email) {
  try {
    const raw = await env.BOOKINGS.get(`loyalty-points:${email}`);
    if (!raw) return { points: 0, transactions: [] };
    
    return JSON.parse(raw);
  } catch (e) {
    return { points: 0, transactions: [] };
  }
}

/**
 * Redeem loyalty points for discount
 */
export async function redeemLoyaltyPoints(env, email, pointsToRedeem, bookingAmount) {
  try {
    const loyaltyData = await getLoyaltyPoints(env, email);
    
    if (loyaltyData.points < pointsToRedeem) {
      return { success: false, error: "Insufficient points" };
    }
    
    // 1 point = ₹0.50 discount (configurable)
    const discountAmount = pointsToRedeem * 0.5;
    
    if (discountAmount > bookingAmount * 0.5) {
      return { success: false, error: "Cannot redeem more than 50% of booking amount" };
    }
    
    // Deduct points
    loyaltyData.points -= pointsToRedeem;
    loyaltyData.lastUpdated = Date.now();
    loyaltyData.transactions.push({
      points: -pointsToRedeem,
      reason: "redeemed_for_discount",
      date: Date.now(),
      balance: loyaltyData.points
    });
    
    const kvKey = `loyalty-points:${email}`;
    await env.BOOKINGS.put(kvKey, JSON.stringify(loyaltyData));
    
    return {
      success: true,
      pointsRedeemed: pointsToRedeem,
      discountAmount,
      finalAmount: bookingAmount - discountAmount,
      remainingPoints: loyaltyData.points
    };
  } catch (e) {
    console.error("Error redeeming points:", e);
    return { success: false, error: e.message };
  }
}

/**
 * Calculate tier based on referral count
 */
function calculateTier(referralCount) {
  if (referralCount >= 20) return "Platinum";
  if (referralCount >= 10) return "Gold";
  if (referralCount >= 5) return "Silver";
  return "Bronze";
}

/**
 * Get leaderboard (top referrers)
 */
export async function getLeaderboard(env, limit = 10) {
  try {
    // This is a simplified version - in production, you'd query KV for all referral-user keys
    // For now, return a sample structure
    const leaderboard = [];
    
    // Note: To implement full leaderboard, you'd need to:
    // 1. Store a global list of all referrer emails
    // 2. Query each one's stats
    // OR use a Durable Object to maintain the leaderboard in real-time
    
    return leaderboard;
  } catch (e) {
    console.error("Error getting leaderboard:", e);
    return [];
  }
}

/**
 * Get user's referral statistics
 */
export async function getUserReferralStats(env, email) {
  try {
    const userRaw = await env.BOOKINGS.get(`referral-user:${email}`);
    if (!userRaw) return null;
    
    const userData = JSON.parse(userRaw);
    const loyaltyData = await getLoyaltyPoints(env, email);
    
    return {
      email,
      code: userData.code,
      tier: userData.tier,
      referralCount: userData.referralCount,
      totalEarnings: userData.totalEarnings,
      loyaltyPoints: loyaltyData.points,
      createdAt: userData.createdAt,
      tierBenefits: getTierBenefits(userData.tier)
    };
  } catch (e) {
    return null;
  }
}

/**
 * Get benefits for tier
 */
function getTierBenefits(tier) {
  const benefits = {
    Bronze: {
      referralDiscount: "10%",
      bookingBonus: "5%",
      pointsMultiplier: 1.0,
      specialPerks: "Basic referral rewards"
    },
    Silver: {
      referralDiscount: "12%",
      bookingBonus: "7%",
      pointsMultiplier: 1.5,
      specialPerks: "Free gear upgrade once per year"
    },
    Gold: {
      referralDiscount: "15%",
      bookingBonus: "10%",
      pointsMultiplier: 2.0,
      specialPerks: "VIP customer support + annual gift"
    },
    Platinum: {
      referralDiscount: "20%",
      bookingBonus: "15%",
      pointsMultiplier: 3.0,
      specialPerks: "Premium concierge service + exclusive events"
    }
  };
  
  return benefits[tier] || benefits.Bronze;
}

/**
 * Check if user is first-time booker
 */
async function isUserFirstBooking(env, email) {
  // This would check the booking history
  // For now, return true (you'd implement this with booking records)
  return true;
}

/**
 * Generate referral share link
 */
export function generateShareLink(baseUrl, referralCode) {
  return `${baseUrl}?ref=${referralCode}`;
}

/**
 * Format earnings for display
 */
export function formatEarnings(amount) {
  return `₹${amount.toFixed(2)}`;
}

/**
 * Get tier color for UI
 */
export function getTierColor(tier) {
  const colors = {
    Bronze: "#CD7F32",
    Silver: "#C0C0C0",
    Gold: "#FFD700",
    Platinum: "#E5E4E2"
  };
  return colors[tier] || colors.Bronze;
}

/**
 * Validate referral code format
 */
export function isValidReferralCode(code) {
  return code && code.match(/^REF_[A-Z0-9_]+$/);
}
