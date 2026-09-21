/**
 * my-booking-api.js
 * -----------------------------------------------------------------------
 * API handlers for My Booking page and related features
 * 
 * Endpoints:
 * POST   /api/my-booking/lookup          - Lookup booking by ID + phone/IP
 * GET    /api/my-booking/:id/:token      - Get booking details (authenticated)
 * POST   /api/my-booking/:id/reschedule  - Request reschedule
 * GET    /api/my-booking/:id/reschedule  - Get reschedule status
 * POST   /api/my-booking/:id/cancel      - Request cancellation
 * GET    /api/my-booking/:id/cancel      - Get cancellation status
 * POST   /api/my-booking/:id/modify      - Request modification
 * GET    /api/my-booking/:id/modify      - Get modification status
 * GET    /api/my-booking/:id/invoice     - Generate invoice PDF/HTML
 * GET    /api/my-booking/:id/itinerary   - Generate itinerary PDF/HTML
 * GET    /api/my-booking/:id/packing     - Generate packing list PDF/HTML
 * GET    /api/cancellation-policy        - Get public cancellation policy
 * POST   /api/cancellation-policy/calc   - Calculate refund for date
 * -----------------------------------------------------------------------
 */

import { json, corsHeaders } from "./booking.js";
import {
  validateBookingAccess,
  getBookingForVisitor,
  requestReschedule,
  getRescheduleRequest,
  requestCancellation,
  getCancellationRequest,
  requestModification,
  getModificationRequest,
  getBookingRequests,
} from "./my-booking.js";
import {
  generateInvoiceHTML,
  generateItineraryHTML,
  generatePackingListHTML,
} from "./invoice-generator.js";
import {
  getRefundPolicy,
  calculateRefund,
  validateCancellation,
  getRefundInfo,
} from "./cancellation-policy.js";
import { blockDate, unblockDate, isDateBlocked } from "./blocked-dates.js";

/**
 * POST /api/my-booking/lookup
 * Lookup booking by ID + access credentials
 */
export async function handleMyBookingLookup(request, env) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "POST required" }, env, 405);
  }

  try {
    const { bookingId, phone, ip, token } = await request.json();

    if (!bookingId) {
      return json(
        { ok: false, error: "bookingId required" },
        env,
        400
      );
    }

    // Try phone first
    if (phone) {
      const booking = await validateBookingAccess(env, bookingId, "phone", phone);
      if (booking) {
        const details = await getBookingForVisitor(env, bookingId, "phone", phone);
        return json({ ok: true, booking: details }, env);
      }
    }

    // Try IP
    if (ip) {
      const booking = await validateBookingAccess(env, bookingId, "ip", ip);
      if (booking) {
        const details = await getBookingForVisitor(env, bookingId, "ip", ip);
        return json({ ok: true, booking: details }, env);
      }
    }

    // Try token
    if (token) {
      const booking = await validateBookingAccess(env, bookingId, "token", token);
      if (booking) {
        const details = await getBookingForVisitor(env, bookingId, "token", token);
        return json({ ok: true, booking: details }, env);
      }
    }

    return json(
      { ok: false, error: "Booking not found or invalid credentials" },
      env,
      404
    );
  } catch (e) {
    console.error("My booking lookup error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * GET /api/my-booking/:id/:token
 * Get full booking details with token auth
 */
export async function handleGetMyBooking(request, env, bookingId, token) {
  try {
    const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
    if (!bookingRaw) {
      return json({ ok: false, error: "Booking not found" }, env, 404);
    }

    const booking = JSON.parse(bookingRaw);
    if (booking.bookingToken !== token) {
      return json({ ok: false, error: "Invalid token" }, env, 403);
    }

    const details = await getBookingForVisitor(env, bookingId, "token", token);
    const requests = await getBookingRequests(env, bookingId);

    return json(
      { ok: true, booking: details, requests },
      env
    );
  } catch (e) {
    console.error("Get my booking error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * POST /api/my-booking/:id/reschedule
 * Request reschedule
 */
export async function handleRescheduleRequest(request, env, bookingId, token) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "POST required" }, env, 405);
  }

  try {
    const { newStartDate, newEndDate, reason } = await request.json();

    // Validate token
    const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
    if (!bookingRaw || JSON.parse(bookingRaw).bookingToken !== token) {
      return json({ ok: false, error: "Invalid token" }, env, 403);
    }

    const result = await requestReschedule(
      env,
      bookingId,
      newStartDate,
      newEndDate,
      reason
    );

    return json(
      {
        ok: true,
        message: "Reschedule request submitted. Admin will review and respond.",
        request: result,
      },
      env
    );
  } catch (e) {
    console.error("Reschedule error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * GET /api/my-booking/:id/reschedule
 * Get reschedule status
 */
export async function handleGetRescheduleStatus(request, env, bookingId, token) {
  try {
    // Validate token
    const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
    if (!bookingRaw || JSON.parse(bookingRaw).bookingToken !== token) {
      return json({ ok: false, error: "Invalid token" }, env, 403);
    }

    const request_ = await getRescheduleRequest(env, bookingId);
    if (!request_) {
      return json(
        { ok: false, error: "No reschedule request found" },
        env,
        404
      );
    }

    return json({ ok: true, request: request_ }, env);
  } catch (e) {
    console.error("Get reschedule status error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * POST /api/my-booking/:id/cancel
 * Request cancellation
 */
export async function handleCancellationRequest(request, env, bookingId, token) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "POST required" }, env, 405);
  }

  try {
    const { reason } = await request.json();

    // Validate token
    const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
    if (!bookingRaw) {
      return json({ ok: false, error: "Booking not found" }, env, 404);
    }

    const booking = JSON.parse(bookingRaw);
    if (booking.bookingToken !== token) {
      return json({ ok: false, error: "Invalid token" }, env, 403);
    }

    // Validate cancellation
    const tourDate = booking.data?.date || booking.data?.startDate;
    const totalCost = booking.data?.totalCost || booking.data?.price;
    const gst = booking.data?.gst || 0;

    const validation = validateCancellation(tourDate, totalCost, gst);
    if (!validation.valid) {
      return json(
        { ok: false, error: validation.reason, refundInfo: null },
        env,
        400
      );
    }

    // Create cancellation request
    const result = await requestCancellation(env, bookingId, reason);

    return json(
      {
        ok: true,
        message:
          "Cancellation request submitted. Refund will be processed after admin approval.",
        request: result,
        refundInfo: validation.refundInfo,
      },
      env
    );
  } catch (e) {
    console.error("Cancellation request error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * GET /api/my-booking/:id/cancel
 * Get cancellation status
 */
export async function handleGetCancellationStatus(request, env, bookingId, token) {
  try {
    // Validate token
    const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
    if (!bookingRaw || JSON.parse(bookingRaw).bookingToken !== token) {
      return json({ ok: false, error: "Invalid token" }, env, 403);
    }

    const request_ = await getCancellationRequest(env, bookingId);
    if (!request_) {
      return json(
        { ok: false, error: "No cancellation request found" },
        env,
        404
      );
    }

    return json({ ok: true, request: request_ }, env);
  } catch (e) {
    console.error("Get cancellation status error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * GET /api/my-booking/:id/invoice
 * Generate and return invoice HTML
 */
export async function handleGetInvoice(request, env, bookingId, token) {
  try {
    // Validate token
    const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
    if (!bookingRaw) {
      return json({ ok: false, error: "Booking not found" }, env, 404);
    }

    const booking = JSON.parse(bookingRaw);
    if (booking.bookingToken !== token) {
      return json({ ok: false, error: "Invalid token" }, env, 403);
    }

    const html = generateInvoiceHTML(booking, bookingId);

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `inline; filename="invoice-${bookingId}.html"`,
        ...corsHeaders(env),
      },
    });
  } catch (e) {
    console.error("Get invoice error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * GET /api/my-booking/:id/itinerary
 * Generate and return itinerary HTML
 */
export async function handleGetItinerary(request, env, bookingId, token) {
  try {
    // Validate token
    const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
    if (!bookingRaw) {
      return json({ ok: false, error: "Booking not found" }, env, 404);
    }

    const booking = JSON.parse(bookingRaw);
    if (booking.bookingToken !== token) {
      return json({ ok: false, error: "Invalid token" }, env, 403);
    }

    const html = generateItineraryHTML(booking, booking.siteId);

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `inline; filename="itinerary-${bookingId}.html"`,
        ...corsHeaders(env),
      },
    });
  } catch (e) {
    console.error("Get itinerary error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * GET /api/my-booking/:id/packing
 * Generate and return packing list HTML
 */
export async function handleGetPackingList(request, env, bookingId, token) {
  try {
    // Validate token
    const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
    if (!bookingRaw) {
      return json({ ok: false, error: "Booking not found" }, env, 404);
    }

    const booking = JSON.parse(bookingRaw);
    if (booking.bookingToken !== token) {
      return json({ ok: false, error: "Invalid token" }, env, 403);
    }

    const html = generatePackingListHTML();

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `inline; filename="packing-list-${bookingId}.html"`,
        ...corsHeaders(env),
      },
    });
  } catch (e) {
    console.error("Get packing list error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * GET /api/cancellation-policy
 * Get public cancellation policy
 */
export async function handleGetCancellationPolicy(request, env) {
  try {
    const policy = getRefundPolicy();
    return json({ ok: true, policy }, env);
  } catch (e) {
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * POST /api/cancellation-policy/calc
 * Calculate refund for a specific date
 */
export async function handleCalculateRefund(request, env) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "POST required" }, env, 405);
  }

  try {
    const { tourDate, totalCost, gst } = await request.json();

    if (!tourDate || !totalCost) {
      return json(
        { ok: false, error: "tourDate and totalCost required" },
        env,
        400
      );
    }

    const refund = calculateRefund(tourDate, totalCost, gst || 0);

    return json({ ok: true, refund }, env);
  } catch (e) {
    console.error("Calculate refund error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * POST /api/admin/block-date
 * Admin endpoint: Block a date (requires admin auth)
 */
export async function handleBlockDate(request, env, isAdminUser) {
  if (!isAdminUser) {
    return json({ ok: false, error: "Admin only" }, env, 403);
  }

  if (request.method !== "POST") {
    return json({ ok: false, error: "POST required" }, env, 405);
  }

  try {
    const { siteId, date, reason } = await request.json();

    if (!siteId || !date) {
      return json(
        { ok: false, error: "siteId and date required" },
        env,
        400
      );
    }

    const success = await blockDate(env, siteId, date, reason || "Unavailable");

    if (success) {
      // TODO: Cancel bookings on this date
      // TODO: Notify guides and visitors

      return json(
        { ok: true, message: `Date ${date} blocked for ${siteId}` },
        env
      );
    } else {
      return json(
        { ok: false, error: "Date already blocked" },
        env,
        400
      );
    }
  } catch (e) {
    console.error("Block date error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * POST /api/admin/unblock-date
 * Admin endpoint: Unblock a date
 */
export async function handleUnblockDate(request, env, isAdminUser) {
  if (!isAdminUser) {
    return json({ ok: false, error: "Admin only" }, env, 403);
  }

  if (request.method !== "POST") {
    return json({ ok: false, error: "POST required" }, env, 405);
  }

  try {
    const { siteId, date } = await request.json();

    if (!siteId || !date) {
      return json(
        { ok: false, error: "siteId and date required" },
        env,
        400
      );
    }

    const success = await unblockDate(env, siteId, date);

    if (success) {
      return json(
        { ok: true, message: `Date ${date} unblocked for ${siteId}` },
        env
      );
    } else {
      return json(
        { ok: false, error: "Date not blocked" },
        env,
        400
      );
    }
  } catch (e) {
    console.error("Unblock date error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}

/**
 * GET /api/admin/blocked-dates
 * Admin endpoint: Get all blocked dates for a site
 */
export async function handleGetBlockedDates(request, env, isAdminUser, siteId) {
  if (!isAdminUser) {
    return json({ ok: false, error: "Admin only" }, env, 403);
  }

  try {
    const { blockDate: blockModule } = await import("./blocked-dates.js");
    const { getBlockedDates } = await import("./blocked-dates.js");

    const blocked = await getBlockedDates(env, siteId);

    return json({ ok: true, blockedDates: blocked }, env);
  } catch (e) {
    console.error("Get blocked dates error:", e);
    return json({ ok: false, error: e.message }, env, 500);
  }
}
