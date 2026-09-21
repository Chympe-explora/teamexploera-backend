/**
 * my-booking.js
 * -----------------------------------------------------------------------
 * "My Booking" page system - visitors can lookup and manage their bookings
 * 
 * Access methods:
 * 1. Booking ID + Phone number
 * 2. Booking ID + IP address
 * 3. Magic link (sent after payment)
 * 
 * Visitors can:
 * - View booking details
 * - Download invoice
 * - Download documents (itinerary, packing list)
 * - Request reschedule
 * - Request cancellation/refund
 * - View status updates
 * - Add to calendar
 * - Modify booking (add/remove travelers)
 * 
 * Data stored with booking:
 *   booking:{id} includes: phone, ip, createdAt, bookingToken (for magic link)
 * -----------------------------------------------------------------------
 */

import { getStatus } from "./status-store.js";

/**
 * Generate a magic link token for "My Booking" page access
 * Token is unique per booking, one-time use initially
 */
export function generateBookingToken() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

/**
 * Validate booking access
 * Returns booking data if valid, null if access denied
 */
export async function validateBookingAccess(env, bookingId, accessMethod, accessValue) {
  const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
  if (!bookingRaw) return null;

  const booking = JSON.parse(bookingRaw);

  // Method 1: Phone number
  if (
    accessMethod === "phone" &&
    booking.data &&
    booking.data.phone === accessValue
  ) {
    return booking;
  }

  // Method 2: IP address
  if (accessMethod === "ip" && booking.ipAddress === accessValue) {
    return booking;
  }

  // Method 3: Magic link token
  if (accessMethod === "token" && booking.bookingToken === accessValue) {
    return booking;
  }

  // Method 4: Email (if stored)
  if (
    accessMethod === "email" &&
    booking.data &&
    booking.data.email === accessValue
  ) {
    return booking;
  }

  return null; // Access denied
}

/**
 * Get booking details for visitor (sanitized)
 */
export async function getBookingForVisitor(env, bookingId, accessMethod, accessValue) {
  const booking = await validateBookingAccess(env, bookingId, accessMethod, accessValue);
  if (!booking) return null;

  // Get current status
  const status = await getStatus(env, bookingId);

  // Build public-safe booking details
  return {
    id: bookingId,
    status,
    siteId: booking.siteId,
    packageKey: booking.data?.pkg,
    startDate: booking.data?.startDate || booking.data?.date,
    endDate: booking.data?.endDate || booking.data?.date,
    travelers: booking.data?.travelers || 1,
    totalCost: booking.data?.totalCost || booking.data?.price,
    gst: booking.data?.gst || 0,
    paymentStatus: booking.paymentStatus || "pending",
    bookingDate: booking.createdAt || Date.now(),
    assignedGuideId: booking.assignedGuideId || null,
    contact: {
      name: booking.data?.name,
      phone: booking.data?.phone,
      email: booking.data?.email || null,
    },
    // Items visitor can do
    canReschedule: status === "confirmed",
    canCancel: status === "confirmed",
    canModify: status === "confirmed",
    canDownloadInvoice: booking.paymentStatus === "completed",
    canDownloadDocuments: status === "confirmed",
    canAddToCalendar: status === "confirmed",
  };
}

/**
 * Request reschedule for a booking
 */
export async function requestReschedule(env, bookingId, newStartDate, newEndDate, reason) {
  const kvKey = `reschedule-requests:${bookingId}`;
  const request = {
    bookingId,
    newStartDate,
    newEndDate,
    reason,
    requestedAt: Date.now(),
    status: "pending", // pending, approved, rejected
    respondedAt: null,
  };

  await env.BOOKINGS.put(kvKey, JSON.stringify(request));

  // TODO: Notify admin/guide via Telegram

  return request;
}

/**
 * Get reschedule request status
 */
export async function getRescheduleRequest(env, bookingId) {
  const raw = await env.BOOKINGS.get(`reschedule-requests:${bookingId}`);
  return raw ? JSON.parse(raw) : null;
}

/**
 * Request cancellation/refund for a booking
 */
export async function requestCancellation(env, bookingId, reason) {
  const kvKey = `cancellation-requests:${bookingId}`;

  // Get booking to calculate refund
  const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
  if (!bookingRaw) return null;

  const booking = JSON.parse(bookingRaw);
  const bookingDate = booking.data?.date || booking.data?.startDate;
  const totalCost = booking.data?.totalCost || booking.data?.price;

  // Calculate refund percentage based on days until tour
  const daysUntil = Math.ceil(
    (new Date(bookingDate) - new Date()) / (1000 * 60 * 60 * 24)
  );

  let refundPercent = 0;
  if (daysUntil >= 14) refundPercent = 100; // Full refund if 14+ days
  else if (daysUntil >= 7) refundPercent = 50; // 50% if 7+ days
  else if (daysUntil >= 3) refundPercent = 25; // 25% if 3+ days
  else refundPercent = 0; // No refund if less than 3 days

  const refundAmount = (totalCost * refundPercent) / 100;

  const request = {
    bookingId,
    reason,
    requestedAt: Date.now(),
    status: "pending",
    refundPercent,
    refundAmount,
    respondedAt: null,
    approvedAt: null,
  };

  await env.BOOKINGS.put(kvKey, JSON.stringify(request));

  // TODO: Notify admin via Telegram

  return request;
}

/**
 * Get cancellation request status
 */
export async function getCancellationRequest(env, bookingId) {
  const raw = await env.BOOKINGS.get(`cancellation-requests:${bookingId}`);
  return raw ? JSON.parse(raw) : null;
}

/**
 * Store booking with access tokens
 * Called when booking is created
 */
export async function storeBookingAccessData(env, bookingId, bookingData, ipAddress) {
  const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
  if (!bookingRaw) return;

  const booking = JSON.parse(bookingRaw);

  // Add access tokens
  booking.ipAddress = ipAddress;
  booking.bookingToken = generateBookingToken();
  booking.createdAt = Date.now();

  // Store updated booking
  await env.BOOKINGS.put(`booking:${bookingId}`, JSON.stringify(booking), {
    expirationTtl: 60 * 60 * 24 * 365, // 1 year
  });
}

/**
 * Get all requests for a booking (reschedule + cancellation)
 */
export async function getBookingRequests(env, bookingId) {
  const reschedule = await getRescheduleRequest(env, bookingId);
  const cancellation = await getCancellationRequest(env, bookingId);

  return {
    reschedule,
    cancellation,
  };
}

/**
 * Create modification request for booking (add/remove travelers)
 */
export async function requestModification(env, bookingId, newTravelerCount, reason) {
  const kvKey = `modify-requests:${bookingId}`;

  const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
  if (!bookingRaw) return null;

  const booking = JSON.parse(bookingRaw);
  const oldTravelers = booking.data?.travelers || 1;
  const oldCost = booking.data?.totalCost || booking.data?.price;

  // Simple calculation: cost per traveler
  const costPerTraveler = oldCost / oldTravelers;
  const newCost = costPerTraveler * newTravelerCount;
  const priceDifference = newCost - oldCost;

  const request = {
    bookingId,
    oldTravelers,
    newTravelers: newTravelerCount,
    oldCost,
    newCost,
    priceDifference, // Positive = they owe more, Negative = refund
    reason,
    requestedAt: Date.now(),
    status: "pending",
    respondedAt: null,
  };

  await env.BOOKINGS.put(kvKey, JSON.stringify(request));

  // TODO: Notify admin via Telegram

  return request;
}

/**
 * Get modification request
 */
export async function getModificationRequest(env, bookingId) {
  const raw = await env.BOOKINGS.get(`modify-requests:${bookingId}`);
  return raw ? JSON.parse(raw) : null;
}
