// ratings-photos.js  —  NEW file for the Worker (teamexploera-backend), next to ratings.js
// -----------------------------------------------------------------------------
// Adds optional photos (max 3) to the existing visitor-rating POST. Nothing here
// changes how ratings are calculated. Photos go to R2; the record just gets a
// `photos` array of R2 keys (empty array when there are none).
//
// Wired in by: ratings.js (POST /api/ratings), index.js (GET /api/rating-photo/*),
// security.js (upload size + photo route), telegram-bot.js (delete cleanup),
// wrangler.toml (R2 binding RATING_PHOTOS).
// -----------------------------------------------------------------------------

export const MAX_PHOTOS = 3;
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;           // 2 MB each, after browser compression
const MAX_REQUEST_BYTES = MAX_PHOTOS * MAX_PHOTO_BYTES + 256 * 1024; // photos + text fields
const KEY_RE = /^reviews\/[A-Za-z0-9_-]{1,64}\/[1-3]\.webp$/;

const bad = (message, status = 400) => ({ ok: false, status, body: { ok: false, error: "photo_invalid", photoError: true, message } });

// Real file-type check from the first bytes (a client-sent MIME type can be faked).
function sniffType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

// Accepts the old JSON body (no photos) or multipart/form-data (with photos).
export async function readRatingRequest(request) {
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) {
    let fields;
    // Same as before: an unreadable body becomes {} and fails the normal "bad site" check.
    fields = await request.json().catch(() => ({}));
    return { ok: true, fields: fields || {}, files: [] };
  }
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_REQUEST_BYTES) return bad("Photos are too large. Each photo must be under 2 MB.", 413);

  let form;
  try { form = await request.formData(); } catch (e) { return { ok: false, status: 400, body: { ok: false, error: "bad request" } }; }

  const files = form.getAll("photos").filter((f) => typeof f !== "string");
  if (files.length > MAX_PHOTOS) return bad("You can add up to 3 photos.");

  const checked = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.size === 0) return bad("One of the photos was empty. Please choose it again.");
    if (f.size > MAX_PHOTO_BYTES) return bad("Photo " + (i + 1) + " is larger than 2 MB. Please choose a smaller photo.", 413);
    if (!["image/jpeg", "image/png", "image/webp"].includes(f.type)) return bad("Photo " + (i + 1) + " must be a JPEG, PNG or WebP image.");
    const bytes = new Uint8Array(await f.arrayBuffer());
    const real = sniffType(bytes);
    if (!real) return bad("Photo " + (i + 1) + " isn't a valid JPEG, PNG or WebP image.");
    checked.push({ bytes, type: real });
  }
  const fields = {};
  for (const k of ["site", "name", "rating", "comment", "sessionId"]) {
    const v = form.get(k);
    if (typeof v === "string") fields[k] = k === "rating" ? Number(v) : v;
  }
  return { ok: true, fields, files: checked };
}

// Stores validated photos in R2 and returns their keys: reviews/{reviewId}/{1..3}.webp
// (the browser converts to WebP; the real content type is stored with the object).
export async function savePhotos(env, reviewId, files) {
  const keys = [];
  if (!files || !files.length) return keys;
  if (!env.RATING_PHOTOS) return keys;
  for (let i = 0; i < files.length; i++) {
    const key = "reviews/" + reviewId + "/" + (i + 1) + ".webp";
    await env.RATING_PHOTOS.put(key, files[i].bytes, { httpMetadata: { contentType: files[i].type } });
    keys.push(key);
  }
  return keys;
}

export async function deletePhotos(env, keys) {
  if (!env.RATING_PHOTOS) return;
  const list = (keys || []).filter((k) => KEY_RE.test(k));
  if (list.length) await env.RATING_PHOTOS.delete(list);
}

// GET /api/rating-photo/reviews/<id>/<n>.webp
export async function servePhoto(request, env, key) {
  if (!KEY_RE.test(key)) return new Response("Not found", { status: 404 });
  const obj = await env.RATING_PHOTOS.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "content-type": (obj.httpMetadata && obj.httpMetadata.contentType) || "image/webp",
      "cache-control": "public, max-age=31536000, immutable",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
}
