/**
 * site-b.js — bookings coming from "Website B" (the Krem Chympe static site, no backend of its own).
 *
 * Admin setting (flip it from the Telegram admin menu → "🏕 Website B Submit"):
 *   mode "whatsapp": the visitor's Submit opens WhatsApp (to the number saved here) with the FULL
 *                    breakdown prefilled. The booking GROUP only gets a short summary
 *                    (package, date, people, total price).
 *   mode "group"   : Submit sends the FULL breakdown (+ payment receipt) straight to the booking
 *                    GROUP. WhatsApp is not opened.
 *
 * Endpoints (public, CORS-restricted to SITE_B_ORIGIN, rate limited in security.js):
 *   GET  /api/siteb/config    -> { mode, whatsapp }
 *   POST /api/siteb/booking   JSON { summary:{...}, message, website(honeypot) } -> { ok, id, mode }
 *   POST /api/siteb/receipt   multipart { id, file }  (group mode only) -> { ok }
 */
import { getDoc, saveDoc } from "./store.js";

const DOC_KEY = "settings:siteB";
const GROUP = (env) => env.TELEGRAM_BOOKING_GROUP_ID || env.TELEGRAM_CHAT_ID;

export async function getSiteBSettings(env) {
  const s = await getDoc(env, DOC_KEY, { mode: "group", whatsapp: "" });
  return { mode: s.mode === "whatsapp" ? "whatsapp" : "group", whatsapp: String(s.whatsapp || "").replace(/\D/g, "") };
}
export async function setSiteBMode(env, mode) {
  const s = await getSiteBSettings(env);
  s.mode = mode === "whatsapp" ? "whatsapp" : "group";
  await saveDoc(env, DOC_KEY, s, { logChange: `Website B submit mode → ${s.mode}` });
  return s;
}
export async function setSiteBWhatsapp(env, digits) {
  const s = await getSiteBSettings(env);
  s.whatsapp = String(digits).replace(/\D/g, "");
  await saveDoc(env, DOC_KEY, s, { logChange: `Website B WhatsApp number → +${s.whatsapp}` });
  return s;
}

// CORS: only Website B's origin (SITE_B_ORIGIN, e.g. https://chympe-explora.github.io). "*" if unset.
function cors(env, request) {
  const allowed = (env.SITE_B_ORIGIN || "*").split(",").map((x) => x.trim()).filter(Boolean);
  const origin = request.headers.get("Origin") || "";
  const ok = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : allowed[0];
  return { "Access-Control-Allow-Origin": ok, "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "content-type", Vary: "Origin" };
}
const reply = (env, request, data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "Cache-Control": "no-store", ...cors(env, request) } });

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, max);
const tg = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, body instanceof FormData ? { method: "POST", body } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

export async function handleSiteBConfig(request, env) {
  const s = await getSiteBSettings(env);
  return reply(env, request, { ok: true, mode: s.mode, whatsapp: s.whatsapp });
}

export async function handleSiteBBooking(request, env) {
  let b;
  try { b = await request.json(); } catch { return reply(env, request, { ok: false, error: "Invalid request." }, 400); }
  if (b.website) return reply(env, request, { ok: true, id: "OK", mode: "group" }); // honeypot: pretend it worked

  const m = b.summary || {};
  const sum = {
    pkg: clean(m.package, 80), date: clean(m.date, 20), people: clean(m.people, 40),
    total: clean(m.total, 20), name: clean(m.name, 80), phone: clean(m.whatsapp, 20),
  };
  const message = clean(b.message, 3500);
  if (!sum.pkg || !sum.date || !sum.people || !sum.total || !message) return reply(env, request, { ok: false, error: "Missing booking details." }, 400);

  const s = await getSiteBSettings(env);
  const id = `WB-${Date.now().toString(36).toUpperCase()}`;
  const chat = GROUP(env);

  // WhatsApp mode → group gets ONLY the short summary. Group mode → the full breakdown.
  const text = s.mode === "whatsapp"
    ? `🏕 <b>New booking ${id}</b> <i>(Website B — via WhatsApp)</i>\n\n<b>Package:</b> ${esc(sum.pkg)}\n<b>Date:</b> ${esc(sum.date)}\n<b>People:</b> ${esc(sum.people)}\n<b>Total price:</b> ${esc(sum.total)}`
    : `🏕 <b>New booking ${id}</b> <i>(Website B)</i>\n\n${esc(message).replace(/\*([^*\n]+)\*/g, "<b>$1</b>")}`;
  const sent = await tg(env, "sendMessage", { chat_id: chat, parse_mode: "HTML", text: text.slice(0, 4000) }).catch(() => null);
  await env.BOOKINGS.put(`siteb:${id}`, JSON.stringify({ id, mode: s.mode, summary: sum, message, at: new Date().toISOString() }), { expirationTtl: 60 * 60 * 24 * 30 });
  if (!sent || !sent.ok) return reply(env, request, { ok: false, error: "Could not reach the booking group. Please try again." }, 502);
  return reply(env, request, { ok: true, id, mode: s.mode });
}

export async function handleSiteBReceipt(request, env) {
  let fd;
  try { fd = await request.formData(); } catch { return reply(env, request, { ok: false, error: "Invalid upload." }, 400); }
  const id = clean(fd.get("id"), 30), file = fd.get("file");
  if (!/^WB-[A-Z0-9]+$/.test(id) || !file || typeof file === "string") return reply(env, request, { ok: false, error: "Bad upload." }, 400);
  if (!(await env.BOOKINGS.get(`siteb:${id}`))) return reply(env, request, { ok: false, error: "Unknown booking." }, 404);
  if (!/^(image\/(jpeg|png)|application\/pdf)$/.test(file.type) || file.size > 3 * 1024 * 1024) return reply(env, request, { ok: false, error: "Receipt must be a JPG, PNG or PDF under 3 MB." }, 400);
  const out = new FormData();
  out.append("chat_id", GROUP(env));
  out.append("caption", `Receipt for ${id}`);
  out.append("document", file, `receipt-${id}.${file.type === "application/pdf" ? "pdf" : file.type === "image/png" ? "png" : "jpg"}`);
  const r = await tg(env, "sendDocument", out).catch(() => null);
  return reply(env, request, { ok: !!(r && r.ok) }, r && r.ok ? 200 : 502);
}

export const siteBPreflight = (request, env) => new Response(null, { headers: cors(env, request) });
