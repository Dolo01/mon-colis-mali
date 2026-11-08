// Public sign-up: phone + password, no SMS.
// The account gets an internal e-mail built from the phone number, created already confirmed.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

export const phoneEmail = (phone: string) => `${phone}@clients.moncolismali.app`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Requête invalide" }, 400); }

  const fullName = String(body.full_name ?? "").trim().slice(0, 80);
  const city = String(body.city ?? "").trim().slice(0, 60);
  const password = String(body.password ?? "");
  let phone = String(body.phone ?? "").replace(/\D/g, "");
  if (phone.startsWith("00")) phone = phone.slice(2);
  if (phone.length === 8) phone = "223" + phone; // numéro malien sans indicatif

  if (fullName.length < 2) return json({ error: "Indiquez votre nom complet." }, 400);
  if (!/^\d{11,15}$/.test(phone)) return json({ error: "Numéro WhatsApp invalide (8 chiffres au Mali)." }, 400);
  if (password.length < 6) return json({ error: "Le mot de passe doit faire au moins 6 caractères." }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: existing } = await admin.from("profiles").select("id").eq("phone", phone).maybeSingle();
  if (existing) return json({ error: "Un compte existe déjà avec ce numéro. Connectez-vous." }, 409);

  const { error } = await admin.auth.admin.createUser({
    email: phoneEmail(phone),
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, phone, city },
  });
  if (error) {
    const dup = /already|registered|exists/i.test(error.message);
    return json({ error: dup ? "Un compte existe déjà avec ce numéro. Connectez-vous." : "Création du compte impossible pour le moment." }, dup ? 409 : 500);
  }
  return json({ ok: true, phone });
});
