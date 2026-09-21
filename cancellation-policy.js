/**
 * cancellation-policy.js
 * -----------------------------------------------------------------------
 * Cancellation policy and refund calculator
 * 
 * Refund policy:
 * - 14+ days before tour: 100% refund (full amount)
 * - 7-13 days before tour: 50% refund
 * - 3-6 days before tour: 25% refund
 * - 0-2 days before tour: 0% refund (non-refundable)
 * 
 * This same logic is used in:
 * 1. Cancellation policy page (public tool)
 * 2. Cancellation request from My Booking
 * 3. Admin cancellation processing
 * -----------------------------------------------------------------------
 */

/**
 * Calculate days until tour
 */
function calculateDaysUntilTour(tourDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tour = new Date(tourDate + "T00:00:00");
  const diffTime = Math.abs(tour - today);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  return diffDays;
}

/**
 * Get refund policy details
 */
export function getRefundPolicy() {
  return {
    title: "Cancellation & Refund Policy",
    policies: [
      {
        daysBeforeTour: 14,
        refundPercent: 100,
        label: "14+ days before tour",
        description: "Full refund of tour cost (GST non-refundable)",
      },
      {
        daysBeforeTour: 7,
        refundPercent: 50,
        label: "7-13 days before tour",
        description: "50% refund of tour cost",
      },
      {
        daysBeforeTour: 3,
        refundPercent: 25,
        label: "3-6 days before tour",
        description: "25% refund of tour cost",
      },
      {
        daysBeforeTour: 0,
        refundPercent: 0,
        label: "0-2 days before tour",
        description: "No refund (non-refundable)",
      },
    ],
  };
}

/**
 * Calculate refund amount for a specific tour date
 * Returns: { refundPercent, refundAmount, totalCost, gst, notes }
 */
export function calculateRefund(tourDate, totalCost, gst = 0) {
  const daysUntil = calculateDaysUntilTour(tourDate);
  let refundPercent = 0;

  if (daysUntil >= 14) {
    refundPercent = 100;
  } else if (daysUntil >= 7) {
    refundPercent = 50;
  } else if (daysUntil >= 3) {
    refundPercent = 25;
  } else {
    refundPercent = 0;
  }

  const refundAmount = (totalCost * refundPercent) / 100;

  return {
    daysUntilTour: daysUntil,
    refundPercent,
    refundAmount,
    tourCost: totalCost,
    gst: gst, // GST is typically non-refundable
    totalRefund: refundAmount, // Does not include GST
    deductedAmount: totalCost - refundAmount,
    notes: getRefundNote(daysUntil, refundPercent),
  };
}

/**
 * Get human-readable refund note
 */
function getRefundNote(daysUntil, refundPercent) {
  if (daysUntil >= 14) {
    return "Full refund will be processed. GST will not be refunded.";
  } else if (daysUntil >= 7) {
    return `50% refund will be processed. ₹${(tourCost * 0.5).toFixed(2)} will be deducted as cancellation fee.`;
  } else if (daysUntil >= 3) {
    return `Only 25% will be refunded. ₹${(tourCost * 0.75).toFixed(2)} will be deducted as cancellation fee.`;
  } else {
    return "No refund will be issued. Tour is non-refundable within 48 hours of departure.";
  }
}

/**
 * Check if tour can be cancelled
 */
export function canCancelTour(tourDate) {
  const daysUntil = calculateDaysUntilTour(tourDate);
  return daysUntil > 0; // Can cancel any time before tour starts
}

/**
 * Get cancellation deadline (last date to cancel and get refund)
 */
export function getCancellationDeadline(refundPercent) {
  const today = new Date();

  if (refundPercent === 100) {
    // 14+ days
    const date = new Date(today);
    date.setDate(date.getDate() + 14);
    return date.toISOString().split("T")[0];
  } else if (refundPercent === 50) {
    // 7 days
    const date = new Date(today);
    date.setDate(date.getDate() + 7);
    return date.toISOString().split("T")[0];
  } else if (refundPercent === 25) {
    // 3 days
    const date = new Date(today);
    date.setDate(date.getDate() + 3);
    return date.toISOString().split("T")[0];
  } else {
    return today.toISOString().split("T")[0]; // Today - no refund
  }
}

/**
 * Get all refund info for a booking
 */
export function getRefundInfo(tourDate, totalCost, gst) {
  const refund = calculateRefund(tourDate, totalCost, gst);
  const policy = getRefundPolicy();

  return {
    ...refund,
    policy,
    deadline: getCancellationDeadline(refund.refundPercent),
    canCancel: canCancelTour(tourDate),
  };
}

/**
 * Validate cancellation request
 * Returns: { valid: bool, reason: string, refundInfo: object }
 */
export function validateCancellation(tourDate, totalCost, gst) {
  const daysUntil = calculateDaysUntilTour(tourDate);

  if (daysUntil <= 0) {
    return {
      valid: false,
      reason: "Tour has already started or is today. Cannot cancel.",
      refundInfo: null,
    };
  }

  const refundInfo = getRefundInfo(tourDate, totalCost, gst);

  return {
    valid: true,
    reason: "Cancellation is allowed",
    refundInfo,
  };
}

/**
 * Generate cancellation confirmation email content
 */
export function generateCancellationEmail(bookingId, guestName, refundAmount, tourDate) {
  return `
Dear ${guestName},

Your tour cancellation has been processed.

Booking ID: ${bookingId}
Tour Date: ${tourDate}
Refund Amount: ₹${refundAmount.toFixed(2)}

The refund will be credited to your original payment method within 5-7 business days.

If you have any questions, please contact us.

Best regards,
Team Explo Era
  `;
}
