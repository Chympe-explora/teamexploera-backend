/**
 * status-store.js — the ONE place booking status and refund status get
 * read or written. This exists to fix a specific bug: confirming a
 * booking in Telegram would flip its status "sometimes instantly, but
 * usually not at all" from the visitor's point of view.
 *
 * ROOT CAUSE: booking.js used to store `status:<id>` / `refundstatus:<id>`
 * directly in Workers KV (env.BOOKINGS). KV is *eventually consistent* —
 * Cloudflare's own docs say a write can take up to 60 seconds to
 * propagate to every edge location, and a given edge location can keep
 * serving its own cached value for up to 60 seconds after that, too.
 * The visitor's browser polls /api/status/:id every 500ms-1s from
 * whatever edge location is nearest to them, which is very likely NOT
 * the same location that handled the guide's Confirm/Reject tap. So the
 * poll would often keep reading a stale "pending" for tens of seconds
 * (occasionally the two happened to line up, which is the "sometimes it
 * works instantly" the reports described) — inherently unpredictable
 * because KV was never designed for tight read-your-own-write loops.
 *
 * FIX: Durable Objects. A single Durable Object instance is the one and
 * only place a given piece of data lives, so every read sees every
 * write immediately, from anywhere, with no propagation window. We use
 * ONE global DO instance for all booking/refund statuses — the data is
 * tiny (a couple of words per booking) and light on traffic, so a
 * single instance is not a bottleneck, and it makes the status flip
 * exactly as instant and reliable every single time.
 *
 * KV is still written alongside the DO (best-effort, non-blocking) as a
 * durable long-term record — nothing else about the data model changes,
 * and any other code path that isn't part of the polling loop keeps
 * reading `booking:<id>` etc. straight from KV as before.
 *
 * Requires the `BOOKING_STATUS` Durable Object binding in wrangler.toml
 * (see the [[durable_objects.bindings]] + [[migrations]] blocks added
 * there). If that binding is ever missing — e.g. a deploy that skipped
 * the wrangler.toml change — this module falls back to KV-only so
 * nothing hard-crashes, but the original inconsistent-polling bug will
 * come back until the binding is deployed.
 */

const STATUS_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days — matches the previous KV TTL

export class BookingStatusDO {
  constructor(state) {
    this.state = state;
  }

  // Simple key/value fetch handler. The key is passed as the path
  // (URL-encoded); GET reads it, PUT writes { value }. Durable Object
  // transactional storage (this.state.storage) is strongly consistent
  // *within this single instance* — that's the whole fix.
  async fetch(request) {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.slice(1));
    if (!key) return new Response(JSON.stringify({ error: "missing key" }), { status: 400 });

    if (request.method === "GET") {
      const value = await this.state.storage.get(key);
      return new Response(JSON.stringify({ value: value ?? null }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (request.method === "PUT") {
      const { value } = await request.json();
      await this.state.storage.put(key, value);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405 });
  }
}

function stub(env) {
  if (!env.BOOKING_STATUS) return null; // binding not deployed yet — caller falls back to KV
  const id = env.BOOKING_STATUS.idFromName("global");
  return env.BOOKING_STATUS.get(id);
}

async function readKey(env, key, fallback) {
  const s = stub(env);
  if (s) {
    const res = await s.fetch(`https://status-store/${encodeURIComponent(key)}`);
    const { value } = await res.json();
    if (value !== null && value !== undefined) return value;
    // Nothing in the DO yet (e.g. a booking written before this migration
    // shipped) — fall through to KV so old bookings still resolve.
  }
  return (await env.BOOKINGS.get(key)) || fallback;
}

async function writeKey(env, key, value) {
  const s = stub(env);
  const writes = [env.BOOKINGS.put(key, value, { expirationTtl: STATUS_TTL_SECONDS })];
  if (s) {
    writes.push(
      s.fetch(`https://status-store/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      })
    );
  }
  await Promise.all(writes);
}

export async function getStatus(env, bookingId) {
  return readKey(env, `status:${bookingId}`, "pending");
}

export async function setStatus(env, bookingId, value) {
  return writeKey(env, `status:${bookingId}`, value);
}

export async function getRefundStatus(env, bookingId) {
  return readKey(env, `refundstatus:${bookingId}`, "none");
}

export async function setRefundStatus(env, bookingId, value) {
  return writeKey(env, `refundstatus:${bookingId}`, value);
}
