// Data layer: everything that talks to Supabase lives here.
import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://xoaoinajanpdhrweohrt.supabase.co";
// Publishable key: safe to ship in the browser, access is enforced by Row Level Security.
export const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY || "sb_publishable_6H2aZnQmNOSS_4MfTIyjhA_pQP5ZS8P";
export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });

export const LOGO = "/logo.webp", LOGO_FULL = "/logo-full.webp", LOGO_LIGHT = "/logo-light.webp";
export const phoneEmail = (phone) => `${phone}@clients.moncolismali.app`;
export const normPhone = (raw) => { let p = String(raw).replace(/\D/g, ""); if (p.startsWith("00")) p = p.slice(2); if (p.length === 8) p = "223" + p; return p; };

export function ph(label, hue) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="hsl(${hue},45%,84%)"/><g fill="none" stroke="hsl(${hue},40%,35%)" stroke-width="7"><path d="M75 110l75-33 75 33v82l-75 33-75-33z"/><path d="M75 110l75 33 75-33M150 143v82"/></g><text x="150" y="272" font-family="sans-serif" font-size="22" text-anchor="middle" fill="hsl(${hue},40%,25%)">${label}</text></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

const must = ({ data, error }) => { if (error) throw error; return data; };
const byPos = (a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id - b.id;

/* ---------- auth ---------- */
export async function currentProfile() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return null;
  const { data, error } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  if (error) throw error;
  return data;
}
export async function signIn(phone, password) {
  const { error } = await sb.auth.signInWithPassword({ email: phoneEmail(normPhone(phone)), password });
  if (error) throw new Error(/invalid/i.test(error.message) ? "Numéro ou mot de passe incorrect." : "Connexion impossible pour le moment. Réessayez.");
}
export async function signUp({ full_name, phone, city, password }) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/signup`, {
    method: "POST", headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
    body: JSON.stringify({ full_name, phone, city, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Création du compte impossible pour le moment.");
  await signIn(body.phone, password);
}
export const signOut = () => sb.auth.signOut();

/* ---------- reads ---------- */
export async function loadSettings() {
  const r = must(await sb.from("settings").select("*").eq("id", 1).single());
  return { name: r.name, slogan: r.slogan, phone: r.phone, address: r.address, color: r.color, accent: r.accent,
    logo: r.logo_url || LOGO, logoUrl: r.logo_url, rates: r.rates || {} };
}

export async function loadAll(me) {
  const [settings, orderRows, lotRows, notifRows, clientRows] = await Promise.all([
    loadSettings(),
    sb.from("orders").select("*, client:profiles(id,full_name,phone,city), order_items(*), quote_lines(*), tracking_events(*), payments(*)").order("id", { ascending: false }).then(must),
    sb.from("lots").select("*").order("id", { ascending: false }).then(must),
    sb.from("notifications").select("*").eq("user_id", me.id).order("created_at", { ascending: false }).limit(200).then(must),
    me.role === "admin" ? sb.from("profiles").select("*").eq("role", "client").order("created_at", { ascending: false }).then(must) : Promise.resolve([me]),
  ]);

  // Private photos -> short-lived signed URLs
  const paths = [...new Set(orderRows.flatMap((o) => o.order_items.map((i) => i.photo_path).filter(Boolean)))];
  const urls = {};
  if (paths.length) {
    const signed = must(await sb.storage.from("photos").createSignedUrls(paths, 60 * 60 * 6));
    signed.forEach((s) => { if (s.signedUrl) urls[s.path] = s.signedUrl; });
  }

  const lots = lotRows.map((l) => ({ dbId: l.id, id: l.ref, origin: l.origin, mode: l.mode, rate: +l.rate, status: l.status,
    createdAt: l.created_at, departedAt: l.departed_at, arrivedAt: l.arrived_at }));
  const lotRef = Object.fromEntries(lots.map((l) => [l.dbId, l.id]));

  const orders = orderRows.map((r) => {
    const items = r.order_items.sort(byPos).map((it) => ({ desc: it.description, qty: it.qty, link: it.link || "",
      photo: it.photo_path ? urls[it.photo_path] || ph("Photo", 230) : ph("Sans photo", 230) }));
    const lines = r.quote_lines.sort(byPos).map((l) => ({ label: l.label, amount: +l.amount }));
    const payments = r.payments.sort((a, b) => a.paid_at.localeCompare(b.paid_at)).map((p) => ({ amount: +p.amount, method: p.method, reference: p.reference, date: p.paid_at }));
    const desc = items.length > 1 ? `${items.length} articles : ${items.map((x) => x.desc.split(",")[0].toLowerCase()).join(", ")}` : items[0]?.desc || "Commande";
    return {
      dbId: r.id, id: r.ref, clientId: r.client_id,
      client: { name: r.client?.full_name || "Client", phone: r.client?.phone || "" },
      origin: r.origin, desc, qty: items.reduce((a, x) => a + x.qty, 0), link: items[0]?.link || "",
      photo: items[0]?.photo || ph("Commande", 230), items, createdAt: r.created_at, status: r.status,
      quote: lines.length ? { lines, note: r.quote_note || "", sentAt: r.quote_sent_at } : null,
      invoice: r.invoice_number ? { number: r.invoice_number, date: r.invoice_date } : null,
      finalInvoice: r.final_invoice_number ? { number: r.final_invoice_number, date: r.final_invoice_date } : null,
      tracking: r.tracking_events.map((e) => ({ stage: e.stage, date: e.created_at })).sort((a, b) => a.stage - b.stage),
      lot: r.lot_id ? lotRef[r.lot_id] || null : null, weightKg: r.weight_kg != null ? +r.weight_kg : null,
      payments, paid: payments.reduce((a, p) => a + p.amount, 0),
    };
  });
  const refById = Object.fromEntries(orders.map((o) => [o.dbId, o.id]));
  const clients = clientRows.map((c) => ({ id: c.id, name: c.full_name, phone: c.phone, city: c.city || "", createdAt: c.created_at }));
  const notifs = notifRows.map((n) => ({ dbId: n.id, id: "n" + n.id, phone: me.phone, orderId: refById[n.order_id] || null,
    kind: n.kind, text: n.body, date: n.created_at, read: n.read }));
  return { settings, orders, lots, notifs, clients };
}

/* ---------- writes ---------- */
async function dataUrlToBlob(u) { return (await fetch(u)).blob(); }

export async function createOrder({ clientId, origin, items }) {
  const order = must(await sb.from("orders").insert({ client_id: clientId, origin }).select("id, ref").single());
  const rows = [];
  for (const [i, it] of items.entries()) {
    let path = null;
    if (it.photo && it.photo.startsWith("data:image/jpeg")) {
      path = `${clientId}/${order.id}-${i}-${crypto.randomUUID().slice(0, 8)}.jpg`;
      const { error } = await sb.storage.from("photos").upload(path, await dataUrlToBlob(it.photo), { contentType: "image/jpeg" });
      if (error) path = null; // the request still goes through without the picture
    }
    rows.push({ order_id: order.id, position: i, description: it.desc, qty: it.qty, link: it.link || null, photo_path: path });
  }
  must(await sb.from("order_items").insert(rows));
  return order;
}
export const sendQuote = (orderId, lines, note) => sb.rpc("send_quote", { p_order: orderId, p_lines: lines, p_note: note }).then(must);
export const respondQuote = (orderId, accept) => sb.rpc("respond_quote", { p_order: orderId, p_accept: accept }).then(must);
export const setStage = (orderId, stage) => sb.rpc("set_stage", { p_order: orderId, p_stage: stage }).then(must);
export const createLot = ({ origin, mode, rate }) => sb.from("lots").insert({ origin, mode, rate }).select("id, ref").single().then(must);
export const assignLot = (orderId, lotId) => sb.from("orders").update({ lot_id: lotId }).eq("id", orderId).then(must);
export const lotDepart = (lotId) => sb.rpc("lot_depart", { p_lot: lotId }).then(must);
export const lotArrive = (lotId, weights) => sb.rpc("lot_arrive", { p_lot: lotId, p_weights: weights }).then(must);
export const addPayment = (orderId, amount, method, reference) =>
  sb.from("payments").insert({ order_id: orderId, amount, method, reference: reference || null }).then(must);
export const markRead = (notifId) => sb.from("notifications").update({ read: true }).eq("id", notifId).then(must);
export const updateProfile = (id, { full_name, city }) => sb.from("profiles").update({ full_name, city }).eq("id", id).then(must);
export async function saveSettings(s) {
  must(await sb.from("settings").update({ name: s.name, slogan: s.slogan, phone: s.phone, address: s.address, color: s.color,
    accent: s.accent, logo_url: s.logoUrl || null, rates: s.rates, updated_at: new Date().toISOString() }).eq("id", 1));
}
export async function uploadLogo(dataUrl) {
  const path = `logo-${Date.now()}.png`;
  must(await sb.storage.from("brand").upload(path, await dataUrlToBlob(dataUrl), { contentType: "image/png", upsert: true }));
  return sb.storage.from("brand").getPublicUrl(path).data.publicUrl;
}

/* ---------- live updates ---------- */
export function onChanges(cb) {
  let t;
  const fire = () => { clearTimeout(t); t = setTimeout(cb, 400); };
  const ch = sb.channel("live");
  ["orders", "notifications", "tracking_events", "lots"].forEach((table) =>
    ch.on("postgres_changes", { event: "*", schema: "public", table }, fire));
  ch.subscribe();
  return () => sb.removeChannel(ch);
}
