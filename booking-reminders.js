/**
 * booking-reminders.js
 * -----------------------------------------------------------------------
 * Automated reminders for guides about upcoming bookings
 * 
 * Reminders sent:
 * - 7 days before tour (preparation reminder)
 * - 3 days before tour (final confirmation)
 * - 1 day before tour (last minute reminder)
 * - Day of tour (final details)
 * 
 * Sent via Telegram to guide's chatId
 * Stored in KV to avoid duplicate reminders
 * -----------------------------------------------------------------------
 */

import { tgSendMessage } from "./telegram.js";
import { getGuides, getEligibleGuides } from "./guides.js";
import { getStatus } from "./status-store.js";

/**
 * Check if reminder was already sent
 */
async function wasReminderSent(env, guideId, bookingId, reminderType) {
  const kvKey = `reminder-sent:${guideId}:${bookingId}:${reminderType}`;
  const sent = await env.BOOKINGS.get(kvKey);
  return !!sent;
}

/**
 * Mark reminder as sent
 */
async function markReminderSent(env, guideId, bookingId, reminderType) {
  const kvKey = `reminder-sent:${guideId}:${bookingId}:${reminderType}`;
  await env.BOOKINGS.put(kvKey, JSON.stringify({ sentAt: Date.now() }), {
    expirationTtl: 60 * 60 * 24 * 30, // Expire after 30 days
  });
}

/**
 * Generate reminder message for guide
 */
function generateReminderMessage(booking, guide, reminderType, daysUntilTour) {
  const {
    data = {},
    siteId,
    assignedGuideId,
    id: bookingId,
  } = booking;

  const tourDate = data.date || data.startDate;
  const endDate = data.endDate || tourDate;
  const travelers = data.travelers || 1;
  const guestName = data.name || "Guest";
  const guestPhone = data.phone || "N/A";
  const packageName = data.pkg || "Tour Package";

  const siteNames = {
    "krem-chympe": "Krem Chympe",
    "wilderness-expedition": "Wilderness Expedition",
  };

  const siteName = siteNames[siteId] || siteId;
  const tourDateStr = new Date(tourDate).toLocaleDateString("en-IN");
  const endDateStr = new Date(endDate).toLocaleDateString("en-IN");

  let message = "";

  if (reminderType === "7days") {
    message = `
📋 **UPCOMING BOOKING - 7 DAYS**

Guide: ${guide.name}
Booking ID: ${bookingId}

📍 Tour: ${siteName} - ${packageName}
📅 Date: ${tourDateStr} to ${endDateStr}
👥 Travelers: ${travelers}
👤 Guest: ${guestName}
📞 Phone: ${guestPhone}

**Action Required:**
- Confirm tour details with guest
- Check weather forecast
- Prepare gear and supplies
- Brief any co-guides

Reply /confirm when ready.
    `;
  } else if (reminderType === "3days") {
    message = `
⏰ **FINAL CONFIRMATION - 3 DAYS**

Booking ID: ${bookingId}
Tour: ${siteName}
📅 Date: ${tourDateStr}
👥 Group: ${travelers} travelers

**Last minute checklist:**
- Contact guest to confirm meeting time
- Check group equipment is ready
- Update weather conditions
- Arrange transport if needed

Confirm again: /confirm
    `;
  } else if (reminderType === "1day") {
    message = `
🚨 **TOMORROW - FINAL DETAILS**

Booking ID: ${bookingId}
📍 ${siteName}
⏰ Meet at: [INSERT MEETING TIME]
👤 Guest: ${guestName} | ${guestPhone}

Everything ready? /confirm
Problems? /issue
    `;
  } else if (reminderType === "today") {
    message = `
🎯 **TODAY IS THE DAY!**

Booking: ${bookingId}
Tour: ${siteName}
Guest: ${guestName} (${guestPhone})
Group: ${travelers} people

Meeting time: [TIME]
Meeting point: [LOCATION]

Safe travels! 🏔️
    `;
  }

  return message.trim();
}

/**
 * Send reminder to guide
 */
async function sendReminderToGuide(env, guide, booking, reminderType) {
  if (!guide.chatId) {
    console.log(`Guide ${guide.id} has no chatId - cannot send reminder`);
    return false;
  }

  try {
    const message = generateReminderMessage(booking, guide, reminderType, 0);

    await tgSendMessage(env, guide.chatId, message);

    return true;
  } catch (e) {
    console.error(`Failed to send reminder to guide ${guide.id}:`, e);
    return false;
  }
}

/**
 * Check and send reminders for all upcoming bookings
 * This should be called periodically (via Cron or scheduled job)
 */
export async function checkAndSendReminders(env) {
  try {
    const guides = await getGuides(env);
    const remindersSent = [];

    for (const guide of guides) {
      // Get guide's schedule
      const kvKey = `guide-schedule:${guide.id}`;
      const raw = await env.BOOKINGS.get(kvKey);
      if (!raw) continue;

      const schedule = JSON.parse(raw);
      const today = new Date().toISOString().split("T")[0];

      for (const booking of schedule) {
        const bookingId = booking.bookingId;
        const startDate = booking.startDate;

        // Calculate days until tour
        const daysUntil = Math.floor(
          (new Date(startDate) - new Date(today)) / (1000 * 60 * 60 * 24)
        );

        // Determine which reminders to send
        const remindersToSend = [];

        if (daysUntil === 7) {
          remindersToSend.push("7days");
        }
        if (daysUntil === 3) {
          remindersToSend.push("3days");
        }
        if (daysUntil === 1) {
          remindersToSend.push("1day");
        }
        if (daysUntil === 0) {
          remindersToSend.push("today");
        }

        // Send reminders if not already sent
        for (const reminderType of remindersToSend) {
          const alreadySent = await wasReminderSent(
            env,
            guide.id,
            bookingId,
            reminderType
          );

          if (!alreadySent) {
            // Get full booking data
            const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
            if (bookingRaw) {
              const booking = JSON.parse(bookingRaw);

              // Get booking status
              const status = await getStatus(env, bookingId);

              // Only send if booking is confirmed
              if (status === "confirmed") {
                const sent = await sendReminderToGuide(
                  env,
                  guide,
                  booking,
                  reminderType
                );

                if (sent) {
                  await markReminderSent(
                    env,
                    guide.id,
                    bookingId,
                    reminderType
                  );
                  remindersSent.push({
                    guideId: guide.id,
                    bookingId,
                    reminderType,
                    daysUntil,
                  });
                }
              }
            }
          }
        }
      }
    }

    return {
      success: true,
      remindersSent,
      count: remindersSent.length,
    };
  } catch (e) {
    console.error("Error in checkAndSendReminders:", e);
    return {
      success: false,
      error: e.message,
    };
  }
}

/**
 * API endpoint: GET /api/admin/reminders/status
 * Get status of all upcoming reminders
 */
export async function handleGetRemindersStatus(env, isAdminUser) {
  if (!isAdminUser) {
    return { ok: false, error: "Admin only" };
  }

  try {
    const result = await checkAndSendReminders(env);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * API endpoint: POST /api/admin/reminders/test
 * Send test reminder to a guide
 */
export async function handleSendTestReminder(env, isAdminUser, guideId) {
  if (!isAdminUser) {
    return { ok: false, error: "Admin only" };
  }

  try {
    const guides = await getGuides(env);
    const guide = guides.find((g) => g.id === guideId);

    if (!guide) {
      return { ok: false, error: "Guide not found" };
    }

    if (!guide.chatId) {
      return { ok: false, error: "Guide has no Telegram chat ID" };
    }

    const testBooking = {
      id: "TEST-BOOKING-001",
      siteId: "krem-chympe",
      data: {
        name: "Test Guest",
        phone: "9876543210",
        date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        travelers: 4,
        pkg: "sharedTour",
      },
    };

    const sent = await sendReminderToGuide(env, guide, testBooking, "7days");

    if (sent) {
      return {
        ok: true,
        message: `Test reminder sent to ${guide.name}`,
      };
    } else {
      return {
        ok: false,
        error: "Failed to send test reminder",
      };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Cron handler - called by Cloudflare Workers Cron Triggers
 * Add to wrangler.toml:
 * 
 * [triggers.crons]
 * crons = ["0 8 * * *"]  // Run daily at 8 AM UTC
 * 
 * In index.js, add to fetch handler:
 * if (request.method === "POST" && request.url.includes("/bookings/cron")) {
 *   const result = await checkAndSendReminders(env);
 *   return json(result, env);
 * }
 */
export async function handleCronReminders(env) {
  console.log("Running scheduled booking reminders check...");
  const result = await checkAndSendReminders(env);
  console.log("Reminders check complete:", result);
  return result;
}
