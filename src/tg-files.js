/**
 * tg-files.js — store and serve uploaded pictures/videos using TELEGRAM as the
 * file storage (same idea as the rest of this Worker: "Telegram is the storage").
 * No R2 bucket needed.
 *
 *   upload : the file is sent to your admin chat as a document (original bytes,
 *            nothing recompressed). Telegram hands back a permanent file_id.
 *   serve  : the Worker resolves the file_id to a fresh Telegram link and streams
 *            the bytes through, forwarding Range requests so videos can seek.
 *
 * Telegram limits for bots: upload up to 50 MB, but DOWNLOAD (what the website needs)
 * only up to 20 MB — so 20 MB is the practical maximum per file.
 */
import { tgResolveFileUrl } from "./telegram.js";

export const TG_MAX_BYTES = 20 * 1024 * 1024;

export async function tgUploadDocument(env, bytes, mime, filename, caption) {
  const chatId = env.TELEGRAM_ADMIN_CHAT_ID;
  if (!chatId || !env.TELEGRAM_BOT_TOKEN) throw new Error("Telegram storage is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID).");
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("disable_notification", "true");
  if (caption) form.append("caption", String(caption).slice(0, 200));
  form.append("document", new Blob([bytes], { type: mime }), filename);
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: "POST", body: form });
  const j = await r.json().catch(() => null);
  const doc = j && j.ok && j.result && j.result.document;
  if (!doc || !doc.file_id) throw new Error("Telegram did not accept the file" + (j && j.description ? ": " + j.description : "."));
  return { fileId: doc.file_id, messageId: j.result.message_id };
}

export async function tgDeleteMessage(env, messageId) {
  if (!messageId || !env.TELEGRAM_ADMIN_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_ADMIN_CHAT_ID, message_id: messageId }),
  }).catch(() => {});
}

// Streams a stored file. `extra` = headers to add (CORS etc). Returns a Response.
export async function tgServeFile(request, env, fileId, mime, extra) {
  const fileUrl = await tgResolveFileUrl(env, fileId).catch(() => null);
  if (!fileUrl) return new Response("Not found", { status: 404 });
  const range = request.headers.get("range");
  const upstream = await fetch(fileUrl, range ? { headers: { Range: range } } : undefined);
  if (!upstream.ok && upstream.status !== 206) return new Response("Not found", { status: 404 });
  const headers = new Headers(extra || {});
  headers.set("content-type", mime);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Accept-Ranges", "bytes");
  for (const h of ["content-length", "content-range"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers });
}
