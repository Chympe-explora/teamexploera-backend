/**
 * siteb-team.js — people who receive Website B bookings in their own Telegram chat.
 *
 * Flow: admin (bot → "👥 Website B Team") taps "Generate code", gives a name → the bot shows a 6-character
 * code. The person pastes that code into the bot; from that moment every new Website B booking is also sent
 * to them (the booking group still gets it too). Codes are one-time and expire after 7 days.
 *
 * KV (env.BOOKINGS):
 *   sbteam:list        -> [{ id, name, chatId, active, code, createdAt, linkedAt }]
 *   sbcode:<code>      -> member id (7-day TTL)
 */
const LIST = "sbteam:list";
const CAP = 50;

export async function getTeam(env) {
  const raw = await env.BOOKINGS.get(LIST);
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
}
const saveTeam = (env, list) => env.BOOKINGS.put(LIST, JSON.stringify(list));

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => chars[b % chars.length]).join("");
}

export async function createMember(env, name) {
  const list = await getTeam(env);
  if (list.length >= CAP) return null;
  const n = (parseInt((await env.BOOKINGS.get("sbteam:counter")) || "0", 10) || 0) + 1;
  await env.BOOKINGS.put("sbteam:counter", String(n));
  const id = `T${n}`, code = randomCode();
  const m = { id, name: String(name || `Member ${id}`).trim().slice(0, 60), chatId: null, active: true, code, createdAt: Date.now(), linkedAt: null };
  list.push(m);
  await saveTeam(env, list);
  await env.BOOKINGS.put(`sbcode:${code}`, id, { expirationTtl: 60 * 60 * 24 * 7 });
  return { member: m, code };
}

export async function regenerateCode(env, id) {
  const list = await getTeam(env);
  const m = list.find((x) => x.id === id);
  if (!m) return null;
  if (m.code) await env.BOOKINGS.delete(`sbcode:${m.code}`);
  m.code = randomCode();
  m.chatId = null; // a fresh code re-links the member (e.g. a new Telegram account)
  m.linkedAt = null;
  await saveTeam(env, list);
  await env.BOOKINGS.put(`sbcode:${m.code}`, id, { expirationTtl: 60 * 60 * 24 * 7 });
  return m.code;
}

// Someone pasted a code into the bot. Returns the linked member, or null if the code isn't valid/pending.
export async function redeemCode(env, code, chatId) {
  const key = `sbcode:${code}`;
  const id = await env.BOOKINGS.get(key);
  if (!id) return null;
  await env.BOOKINGS.delete(key);
  const list = await getTeam(env);
  const m = list.find((x) => x.id === id);
  if (!m) return null;
  m.chatId = String(chatId);
  m.code = null;
  m.linkedAt = Date.now();
  m.active = true;
  await saveTeam(env, list);
  return m;
}

export async function getMemberByChat(env, chatId) {
  return (await getTeam(env)).find((x) => x.chatId && String(x.chatId) === String(chatId)) || null;
}
export async function setMemberActive(env, id, active) {
  const list = await getTeam(env);
  const m = list.find((x) => x.id === id);
  if (!m) return null;
  m.active = !!active;
  await saveTeam(env, list);
  return m;
}
export async function removeMember(env, id) {
  const list = await getTeam(env);
  const m = list.find((x) => x.id === id);
  if (m && m.code) await env.BOOKINGS.delete(`sbcode:${m.code}`);
  await saveTeam(env, list.filter((x) => x.id !== id));
}
// Chat ids that should get a copy of each new Website B booking.
export async function activeRecipients(env) {
  return (await getTeam(env)).filter((m) => m.chatId && m.active).map((m) => m.chatId);
}

// Members who should get a copy of each new booking (full records, so we can log who received it).
export async function activeMembers(env) {
  return (await getTeam(env)).filter((m) => m.chatId && m.active);
}

// ---- booking index, for the admin's "📋 Website B Bookings" screens ----
async function pushIds(env, key, id) {
  let list = [];
  try { list = JSON.parse((await env.BOOKINGS.get(key)) || "[]"); } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  list.push(id);
  await env.BOOKINGS.put(key, JSON.stringify(list.slice(-300)), { expirationTtl: 60 * 60 * 24 * 180 });
}
export async function indexBooking(env, id, memberIds) {
  await pushIds(env, "sbbook:all", id);
  for (const m of memberIds) await pushIds(env, `sbbook:${m}`, id);
}
export async function bookingIds(env, memberId) {
  try { const a = JSON.parse((await env.BOOKINGS.get(memberId ? `sbbook:${memberId}` : "sbbook:all")) || "[]"); return Array.isArray(a) ? a : []; } catch { return []; }
}
export async function getBooking(env, id) {
  try { return JSON.parse((await env.BOOKINGS.get(`siteb:${id}`)) || "null"); } catch { return null; }
}
