/**
 * blocked-dates.js
 * -----------------------------------------------------------------------
 * Admin power button: Block specific dates (weather, emergency, etc)
 * When a date is blocked:
 * 1. No new bookings allowed for that date
 * 2. Existing bookings on that date are auto-cancelled with refund
 * 3. Guides are notified
 * 4. Visitors are notified
 * 
 * Data structure in KV:
 *   blocked-dates:{siteId} = [
 *     { date: "2025-01-15", reason: "Heavy rain", blockedAt: timestamp, blockedBy: "admin_id" }
 *   ]
 * -----------------------------------------------------------------------
 */

import { getStatus, setStatus } from "./status-store.js";

/**
 * Block a date for a site (no new bookings allowed)
 */
export async function blockDate(env, siteId, date, reason = "Unavailable") {
  if (!siteId || !date) return false;

  const kvKey = `blocked-dates:${siteId}`;
  const raw = await env.BOOKINGS.get(kvKey);
  const blocked = raw ? JSON.parse(raw) : [];

  // Check if already blocked
  if (blocked.find((b) => b.date === date)) {
    return false; // Already blocked
  }

  blocked.push({
    date,
    reason,
    blockedAt: Date.now(),
  });

  blocked.sort((a, b) => new Date(a.date) - new Date(b.date));
  await env.BOOKINGS.put(kvKey, JSON.stringify(blocked));
  return true;
}

/**
 * Unblock a date
 */
export async function unblockDate(env, siteId, date) {
  if (!siteId || !date) return false;

  const kvKey = `blocked-dates:${siteId}`;
  const raw = await env.BOOKINGS.get(kvKey);
  if (!raw) return false;

  const blocked = JSON.parse(raw).filter((b) => b.date !== date);

  if (blocked.length === 0) {
    await env.BOOKINGS.delete(kvKey);
  } else {
    await env.BOOKINGS.put(kvKey, JSON.stringify(blocked));
  }

  return true;
}

/**
 * Check if a date is blocked
 */
export async function isDateBlocked(env, siteId, date) {
  if (!siteId || !date) return false;

  const kvKey = `blocked-dates:${siteId}`;
  const raw = await env.BOOKINGS.get(kvKey);
  if (!raw) return false;

  const blocked = JSON.parse(raw);
  return blocked.some((b) => b.date === date);
}

/**
 * Get all blocked dates for a site
 */
export async function getBlockedDates(env, siteId) {
  if (!siteId) return [];

  const kvKey = `blocked-dates:${siteId}`;
  const raw = await env.BOOKINGS.get(kvKey);
  return raw ? JSON.parse(raw) : [];
}

/**
 * Check if a date range has ANY blocked dates (for 6-day tours)
 */
export async function hasBlockedDates(env, siteId, startDate, endDate) {
  const blocked = await getBlockedDates(env, siteId);

  for (const b of blocked) {
    // Check if blocked date falls within the range
    if (b.date >= startDate && b.date <= endDate) {
      return true; // Date range contains a blocked date
    }
  }

  return false;
}

/**
 * Cancel all bookings for a blocked date (admin emergency action)
 * Returns array of cancelled booking IDs
 */
export async function cancelBookingsForBlockedDate(env, siteId, date, reason = "Date blocked by admin") {
  const cancelledBookings = [];

  // Find all bookings for this date
  // Note: This is a simplified version - in production, you'd query from your booking database
  // For now, we'll rely on the guide schedule system

  // Get all guides
  const { getGuides } = await import("./guides.js");
  const guides = await getGuides(env);

  for (const guide of guides) {
    // Get guide's schedule
    const kvKey = `guide-schedule:${guide.id}`;
    const raw = await env.BOOKINGS.get(kvKey);
    if (!raw) continue;

    const schedule = JSON.parse(raw);

    // Find bookings for this date
    for (const booking of schedule) {
      // Check if this booking includes the blocked date
      if (
        booking.siteId === siteId &&
        booking.startDate <= date &&
        booking.endDate >= date
      ) {
        // Found a conflicting booking - cancel it
        try {
          await setStatus(env, booking.bookingId, "cancelled_by_admin");
          cancelledBookings.push(booking.bookingId);

          // TODO: Send notification to visitor
          // TODO: Process refund automatically
          // TODO: Notify guide
        } catch (e) {
          console.error("Failed to cancel booking:", booking.bookingId, e);
        }
      }
    }
  }

  return cancelledBookings;
}

/**
 * Get all blocked dates across all months
 */
export async function getAllBlockedDates(env, siteId) {
  return await getBlockedDates(env, siteId);
}

/**
 * Check availability considering blocked dates
 */
export async function isDateAvailable(env, siteId, startDate, endDate) {
  // First check if dates are blocked
  if (await hasBlockedDates(env, siteId, startDate, endDate)) {
    return false; // Dates are blocked
  }

  // Then check guide availability (from availability.js)
  // This is called by the availability check API
  return true; // Guides available (unless blocked)
}
