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
    // Serialises claim/release operations (see POST/DELETE below) so the
    // read-then-write inside them can never interleave with another
    // request's, whatever the runtime's gating rules are.
    this.lock = Promise.resolve();
  }

  serialise(fn) {
    const run = this.lock.then(fn);
    this.lock = run.catch(() => {});
    return run;
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

    // POST = atomic "claim once". The first caller to reach a key wins
    // and stores its value; every later caller gets { claimed: false }
    // plus whatever the winner stored. Because this whole handler runs
    // inside ONE Durable Object instance (and there is no await between
    // the read and the write that another request could interleave
    // with), two visitors submitting the same single-use referral code
    // at the same instant can never both succeed — which plain KV
    // (get-then-put, eventually consistent) cannot guarantee.
    if (request.method === "POST") {
      const { value } = await request.json();
      const result = await this.serialise(async () => {
        const existing = await this.state.storage.get(key);
        if (existing !== undefined && existing !== null) return { claimed: false, value: existing };
        await this.state.storage.put(key, value);
        return { claimed: true, value };
      });
      return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
    }

    // DELETE = release a claim, but only if it is still held by the
    // caller that made it (so a slow/failed request can never free a
    // claim that a different booking has since legitimately taken).
    if (request.method === "DELETE") {
      let ifValue = null;
      try { ({ ifValue } = await request.json()); } catch (e) { /* no body = unconditional */ }
      const released = await this.serialise(async () => {
        const existing = await this.state.storage.get(key);
        if (existing !== undefined && existing !== null && (ifValue === null || existing === ifValue)) {
          await this.state.storage.delete(key);
          return true;
        }
        return false;
      });
      return new Response(JSON.stringify({ released }), { headers: { "content-type": "application/json" } });
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

// ---------------------------------------------------------------------
// One-time claims (used by referrals.js for single-use referral codes).
// Same Durable Object as the statuses above, but with an atomic
// first-writer-wins operation instead of read/write. Falls back to a
// (non-atomic) KV get-then-put only if the DO binding is missing, so
// nothing hard-crashes — but the "two people at the exact same moment"
// guarantee only holds with the BOOKING_STATUS binding deployed.
// ---------------------------------------------------------------------

// Returns { claimed: true } if this call took the claim, or
// { claimed: false, value } (value = whoever holds it) if it was taken.
export async function claimOnce(env, key, value) {
  const s = stub(env);
  if (s) {
    const res = await s.fetch(`https://status-store/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });
    return res.json();
  }
  const existing = await env.BOOKINGS.get(key);
  if (existing) return { claimed: false, value: existing };
  await env.BOOKINGS.put(key, value);
  return { claimed: true, value };
}

// Who holds this claim right now (or null).
export async function getClaim(env, key) {
  const s = stub(env);
  if (s) {
    const res = await s.fetch(`https://status-store/${encodeURIComponent(key)}`);
    const { value } = await res.json();
    return value ?? null;
  }
  return (await env.BOOKINGS.get(key)) || null;
}

// Frees a claim, but only if `ifValue` still holds it.
export async function releaseClaim(env, key, ifValue) {
  const s = stub(env);
  if (s) {
    await s.fetch(`https://status-store/${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ifValue: ifValue ?? null }),
    });
    return;
  }
  const existing = await env.BOOKINGS.get(key);
  if (existing && (ifValue == null || existing === ifValue)) await env.BOOKINGS.delete(key);
}
