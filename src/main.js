import "./styles.css";
import { registerSW } from "virtual:pwa-register";
import * as api from "./api.js";
import { LOGO, LOGO_FULL, LOGO_LIGHT, ph, normPhone } from "./api.js";

window.__PWA = true;
registerSW({ immediate: true });
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); window.__pwaPrompt = e; window.dispatchEvent(new Event("pwa-installable")); });

const ORIGINS = ["Chine","Lomé (Togo)","Burkina Faso","Niger","Sénégal"];
const MODES = ["Aérien","Maritime","Route"];
const STAGES = ["Commande validée","Colis acheté","Expédié","Arrivé au Mali","Livré au client"];
const MALI = 3;

const ago = (days) => new Date(Date.now() - days*864e5).toISOString();
const now = () => new Date().toISOString();

let db = {settings:{name:"Mon Colis Mali",slogan:"",phone:"",address:"",color:"#14297a",accent:"#f39314",logo:LOGO,rates:{}}, orders:[], lots:[], notifs:[], clients:[]};
let me = null; // signed-in profile
const st = {role:"client", session:null, view:"orders", sel:null, filter:"tous", ready:false};

/* run an action against the server, then reload */
let busy = false;
async function act(fn, okMsg){
  if(busy) return false; busy = true; document.body.style.cursor = "progress";
  try{ await fn(); await reload(); if(okMsg) toast(okMsg); return true; }
  catch(e){ console.error(e); toast(e?.message && /[a-zéè]/i.test(e.message) && e.message.length < 140 ? e.message : "Erreur réseau : réessayez."); return false; }
  finally{ busy = false; document.body.style.cursor = ""; }
}
async function reload(){
  if(!me) return;
  db = await api.loadAll(me);
  render();
}

const $ = (s, r=document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const nf = new Intl.NumberFormat("fr-FR");
const money = (n) => nf.format(Math.round(n||0)).replace(/ | /g," ") + " FCFA";
const fdate = (iso) => iso ? new Date(iso).toLocaleDateString("fr-FR",{day:"2-digit",month:"short",year:"numeric"}) : "—";
const ftime = (iso) => new Date(iso).toLocaleString("fr-FR",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"});
const fmtPhone = (p) => "+" + String(p).replace(/^(\d{3})(\d{2})(\d{2})(\d{2})(\d{2})$/,"$1 $2 $3 $4 $5");
const waLink = (phone, text) => "https://wa.me/" + phone + "?text=" + encodeURIComponent(text);
const initials = (n) => n.split(/\s+/).map(w=>w[0]).slice(0,2).join("").toUpperCase();
const lastStage = (o) => o.tracking.length ? Math.max(...o.tracking.map(t=>t.stage)) : -1;
const getLot = (id) => db.lots.find(l=>l.id===id);
const getClient = (phone) => db.clients.find(c=>c.phone===phone);
const PAY = {orange_money:"Orange Money", wave:"Wave", especes:"Espèces"};
const pad = (n) => String(n).padStart(4,"0");

/* money logic */
function transportLine(o){
  if(o.weightKg==null) return null;
  const lot = getLot(o.lot); const rate = lot ? lot.rate : (db.settings.rates[o.origin]||0);
  return {label:`Transport ${lot?lot.mode.toLowerCase():""} ${o.origin} → Bamako (${String(o.weightKg).replace(".",",")} kg × ${money(rate)})`, amount:Math.round(o.weightKg*rate)};
}
function docLines(o, kind){
  const lines = (o.quote?.lines||[]).slice();
  if(kind==="arrivee"){ const t = transportLine(o); if(t) lines.push(t); }
  return lines;
}
const sum = (lines) => lines.reduce((a,l)=>a+(+l.amount||0),0);
const grand = (o) => sum(docLines(o, o.weightKg!=null ? "arrivee" : "facture"));

function statusOf(o){
  const admin = st.role==="admin";
  if(o.status==="demande") return admin ? ["À chiffrer","p-new"] : ["En attente du devis","p-new"];
  if(o.status==="devis") return admin ? ["Devis envoyé","p-quote"] : ["Devis à valider","p-new"];
  if(o.status==="refuse") return ["Devis refusé","p-bad"];
  const s = lastStage(o);
  if(s===1 && admin && !o.lot) return ["Acheté, à expédier","p-new"];
  return [STAGES[Math.max(0,s)], s>=MALI ? "p-ok" : "p-quote"];
}
const pill = (o) => { const [t,c] = statusOf(o); return `<span class="pill ${c}">${esc(t)}</span>`; };
const lotPill = (l) => l.status==="chargement" ? `<span class="pill p-new">En préparation</span>` : l.status==="transit" ? `<span class="pill p-quote">En route</span>` : `<span class="pill p-ok">Arrivé au Mali</span>`;

function toast(t){ const el=$("#toast"); el.textContent=t; el.hidden=false; clearTimeout(toast.t); toast.t=setTimeout(()=>el.hidden=true,2800); }
async function copy(text){
  try{ await navigator.clipboard.writeText(text); toast("Message copié"); }
  catch(e){ const pre = $("#dlg .msg"); if(pre){ const r=document.createRange(); r.selectNodeContents(pre); const s=getSelection(); s.removeAllRanges(); s.addRange(r);} toast("Sélectionnez le texte puis copiez-le"); }
}
/* ---------- DOCUMENT RENDERER (canvas → PNG / PDF) ---------- */
const imgCache = new Map();
function loadImg(src){
  if(!src) return Promise.resolve(null);
  if(imgCache.has(src)) return imgCache.get(src);
  const p = new Promise(res=>{ const i=new Image(); if(/^https?:/.test(src)) i.crossOrigin="anonymous"; i.onload=()=>res(i); i.onerror=()=>res(null); i.src=src; });
  imgCache.set(src,p); return p;
}
function rgba(hex, a){ const n=parseInt(hex.slice(1),16); return `rgba(${n>>16&255},${n>>8&255},${n&255},${a})`; }
function rr(ctx,x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }
function wrap(ctx, text, maxW){ const words=String(text).split(" "); const out=[]; let line=""; for(const w of words){ const t=line?line+" "+w:w; if(ctx.measureText(t).width>maxW && line){ out.push(line); line=w; } else line=t; } if(line) out.push(line); return out; }
function cover(ctx, img, x, y, w, h){ const s=Math.max(w/img.width,h/img.height); const sw=w/s, sh=h/s; ctx.drawImage(img,(img.width-sw)/2,(img.height-sh)/2,sw,sh,x,y,w,h); }

async function drawDoc(o, kind, S = db.settings){
  try{ await document.fonts.ready }catch(e){}
  const W=1240, H=1754, cv=document.createElement("canvas"); cv.width=W; cv.height=H;
  const c=cv.getContext("2d"), brand=S.color||"#2f3fa3", acc=S.accent||"#e08a12", ink="#161a33", mute="#646a8a";
  const D="'Bricolage Grotesque', 'Segoe UI', sans-serif", B="'Public Sans', 'Segoe UI', sans-serif";
  c.fillStyle="#fff"; c.fillRect(0,0,W,H);
  // header band + accent wedge
  c.fillStyle=brand; c.fillRect(0,0,W,260);
  c.fillStyle=acc; c.beginPath(); c.moveTo(W-300,0); c.lineTo(W,0); c.lineTo(W,260); c.lineTo(W-430,260); c.closePath(); c.fill();
  c.fillStyle=rgba("#ffffff",.08); c.beginPath(); c.moveTo(W-470,0); c.lineTo(W-330,0); c.lineTo(W-460,260); c.lineTo(W-600,260); c.closePath(); c.fill();
  // logo
  const isDefaultLogo = S.logo===LOGO;
  const logo = await loadImg(isDefaultLogo ? LOGO_LIGHT : S.logo);
  if(logo && isDefaultLogo){
    const s=Math.min(600/logo.width,128/logo.height); c.drawImage(logo,60,118-logo.height*s/2,logo.width*s,logo.height*s);
    c.fillStyle="#fff"; c.globalAlpha=.85; c.font=`500 21px ${B}`; c.fillText(S.slogan||"",60,222); c.globalAlpha=1;
    c.font=`600 22px ${B}`; c.fillStyle="#fff"; c.textAlign="right"; c.fillText(S.phone||"",W-470,222); c.textAlign="left";
  } else if(logo && logo.width/logo.height>1.3){
    c.fillStyle="#fff"; rr(c,50,26,450,208,22); c.fill();
    const s=Math.min(420/logo.width,186/logo.height); c.drawImage(logo,275-logo.width*s/2,130-logo.height*s/2,logo.width*s,logo.height*s);
    ["#14b53a","#fcd116","#ce1126"].forEach((col,i)=>{ c.fillStyle=col; c.fillRect(530+i*26,52,22,8); });
    c.fillStyle="#fff"; c.font=`700 26px ${D}`; wrap(c,S.slogan||"",270).slice(0,3).forEach((l,i)=>c.fillText(l,530,104+i*34));
    c.font=`600 22px ${B}`; c.globalAlpha=.9; c.fillText(S.phone||"",530,222); c.globalAlpha=1;
  } else {
  c.save(); c.fillStyle="#fff"; c.beginPath(); c.arc(140,130,82,0,Math.PI*2); c.fill(); c.clip();
  if(logo){ const s=Math.min(140/logo.width,140/logo.height); c.drawImage(logo,140-logo.width*s/2,130-logo.height*s/2,logo.width*s,logo.height*s); }
  else { c.fillStyle=brand; c.font=`800 64px ${D}`; c.textAlign="center"; c.textBaseline="middle"; c.fillText(initials(S.name||"MC"),140,134); }
  c.restore(); c.textAlign="left"; c.textBaseline="alphabetic";
  c.fillStyle="#fff"; c.font=`800 50px ${D}`; c.fillText(S.name||"", 250, 118);
  c.font=`400 23px ${B}`; c.globalAlpha=.9; wrap(c,S.slogan||"",560).slice(0,2).forEach((l,i)=>c.fillText(l,250,158+i*30)); c.globalAlpha=1;
  c.font=`600 22px ${B}`; c.fillText(`${S.phone||""}`, 250, 228);
  }
  // title + meta
  const titles={devis:"DEVIS", facture:"FACTURE", arrivee:"FACTURE D'ARRIVÉE"};
  const num = kind==="devis" ? "DEV-"+o.id.slice(4) : kind==="facture" ? o.invoice?.number : o.finalInvoice?.number;
  const dt = kind==="devis" ? o.quote?.sentAt : kind==="facture" ? o.invoice?.date : o.finalInvoice?.date;
  c.fillStyle=brand; c.font=`800 ${kind==="arrivee"?60:76}px ${D}`; c.fillText(titles[kind], 80, 370);
  c.fillStyle=acc; c.fillRect(80,392,120,8);
  c.textAlign="right"; c.fillStyle=mute; c.font=`600 20px ${B}`;
  [["N°",num||"—"],["Date",fdate(dt||now())],["Commande",o.id]].forEach(([k,v],i)=>{ c.fillStyle=mute; c.font=`600 20px ${B}`; c.fillText(k.toUpperCase(), W-330, 318+i*40); c.fillStyle=ink; c.font=`700 24px ${B}`; c.fillText(v, W-80, 318+i*40); });
  c.textAlign="left";
  // client + shipment boxes
  const bx=(x,label,rows)=>{ c.fillStyle=rgba(brand,.06); rr(c,x,450,520,190,16); c.fill(); c.fillStyle=brand; c.font=`700 18px ${B}`; c.fillText(label,x+28,492); rows.forEach((r,i)=>{ c.fillStyle=i===0?ink:mute; c.font=i===0?`700 30px ${B}`:`400 23px ${B}`; c.fillText(r,x+28,538+i*36); }); };
  const cl = getClient(o.client.phone);
  bx(80, kind==="devis"?"DEVIS ÉTABLI POUR":"FACTURÉ À", [o.client.name, fmtPhone(o.client.phone), cl?.city||""]);
  const lot = getLot(o.lot);
  bx(640, "EXPÉDITION", [`${o.origin} → Bamako`, lot?`${lot.mode} · ${lot.id}`:"Mode à définir", o.weightKg!=null?`Poids : ${String(o.weightKg).replace(".",",")} kg`:`Quantité : ${o.qty}`]);
  // product
  const items = o.items && o.items.length ? o.items : [{photo:o.photo,desc:o.desc,qty:o.qty}];
  if(items.length===1){
    const ph = await loadImg(items[0].photo);
    c.save(); rr(c,80,680,170,170,14); c.clip(); c.fillStyle="#eee"; c.fillRect(80,680,170,170); if(ph) cover(c,ph,80,680,170,170); c.restore();
    c.fillStyle=mute; c.font=`700 18px ${B}`; c.fillText("ARTICLE",280,712);
    c.fillStyle=ink; c.font=`600 28px ${B}`; wrap(c,items[0].desc,880).slice(0,3).forEach((l,i)=>c.fillText(l,280,752+i*38));
    c.fillStyle=mute; c.font=`400 22px ${B}`; c.fillText(`Quantité : ${items[0].qty}`,280,840);
  } else {
    c.fillStyle=mute; c.font=`700 18px ${B}`; c.fillText(`ARTICLES (${items.length})`,80,690);
    const show=items.slice(0,6), tw=150, gap=(W-160-tw*6)/5;
    for(let i=0;i<show.length;i++){
      const x=80+i*(tw+gap), im=await loadImg(show[i].photo);
      c.save(); rr(c,x,705,tw,tw,14); c.clip(); c.fillStyle="#eee"; c.fillRect(x,705,tw,tw); if(im) cover(c,im,x,705,tw,tw); c.restore();
      if(i===5 && items.length>6){ c.fillStyle="rgba(0,0,0,.55)"; rr(c,x,705,tw,tw,14); c.fill(); c.fillStyle="#fff"; c.font=`800 40px ${D}`; c.textAlign="center"; c.fillText("+"+(items.length-5),x+tw/2,795); c.textAlign="left"; }
      c.fillStyle=ink; c.font=`600 17px ${B}`; const cap=wrap(c,show[i].desc,tw)[0]; c.fillText(cap.length<show[i].desc.length?cap.replace(/.$/,"…"):cap,x,878);
    }
  }
  // table
  const lines = docLines(o, kind); let y=900;
  c.fillStyle=brand; rr(c,80,y,W-160,60,10); c.fill();
  c.fillStyle="#fff"; c.font=`700 19px ${B}`; c.fillText("DÉSIGNATION",108,y+38); c.textAlign="right"; c.fillText("MONTANT",W-108,y+38); c.textAlign="left";
  y+=60;
  lines.forEach((l,i)=>{ const h=64; if(i%2){ c.fillStyle=rgba(brand,.05); c.fillRect(80,y,W-160,h);} c.fillStyle=ink; c.font=`400 24px ${B}`; c.fillText(wrap(c,l.label,760)[0],108,y+41); c.textAlign="right"; c.font=`600 24px ${B}`; c.fillText(money(l.amount),W-108,y+41); c.textAlign="left"; y+=h; });
  c.fillStyle="#e3e5ef"; c.fillRect(80,y,W-160,2);
  // totals
  const total=sum(lines), paid = kind==="devis"?0:(o.paid||0), rest=Math.max(0,total-paid);
  y+=30; const tx=W-520;
  const trow=(k,v,bold)=>{ c.fillStyle=bold?ink:mute; c.font=`${bold?700:500} 24px ${B}`; c.fillText(k,tx,y+28); c.textAlign="right"; c.fillText(v,W-108,y+28); c.textAlign="left"; y+=44; };
  trow("Total", money(total), true);
  if(kind!=="devis") trow("Déjà payé", "− "+money(paid));
  y+=10; c.fillStyle=brand; rr(c,tx-28,y,W-80-tx+28,84,14); c.fill();
  c.fillStyle="#fff"; c.font=`700 22px ${B}`; c.fillText(kind==="devis"?"TOTAL À PAYER":"RESTE À PAYER",tx,y+52); c.textAlign="right"; c.font=`800 36px ${D}`; c.fillText(money(kind==="devis"?total:rest),W-108,y+55); c.textAlign="left";
  // stamp / note on left
  const stampTxt = kind==="devis" ? "VALABLE 7 JOURS" : rest===0 ? "PAYÉE" : kind==="arrivee" ? "ARRIVÉ À BAMAKO" : "VALIDÉE";
  const stampCol = rest===0 && kind!=="devis" ? "#1d8a55" : acc;
  const sy = y - (kind==="devis"?40:80);
  c.save(); c.translate(250,sy+40); c.rotate(-0.08); c.strokeStyle=stampCol; c.lineWidth=5; c.font=`800 30px ${D}`; const sw=c.measureText(stampTxt).width+50; rr(c,-sw/2,-36,sw,72,12); c.stroke(); c.fillStyle=stampCol; c.textAlign="center"; c.fillText(stampTxt,0,11); c.restore(); c.textAlign="left";
  if(o.quote?.note && kind==="devis"){ c.fillStyle=mute; c.font=`italic 400 21px ${B}`; wrap(c,o.quote.note,520).slice(0,3).forEach((l,i)=>c.fillText(l,80,sy+120+i*30)); }
  // footer
  c.fillStyle=acc; c.fillRect(80,H-210,W-160,4);
  c.fillStyle=ink; c.font=`700 26px ${D}`; c.fillText(kind==="arrivee"?"Votre colis vous attend à Bamako.":kind==="devis"?"Validez ce devis dans votre espace client.":"Merci pour votre confiance !",80,H-150);
  c.fillStyle=mute; c.font=`400 21px ${B}`; c.fillText([S.address, S.phone && S.phone+" (WhatsApp)"].filter(Boolean).join("  ·  "),80,H-112);
  c.fillStyle=brand; c.fillRect(0,H-48,W,48); c.fillStyle=acc; c.fillRect(0,H-48,260,48);
  return cv;
}
async function toPDF(cv){
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({unit:"pt",format:"a4"}); doc.addImage(cv.toDataURL("image/jpeg",.92),"JPEG",0,0,595.28,841.89); return doc.output("blob");
}
const toPNG = (cv) => new Promise(r=>cv.toBlob(r,"image/png"));
async function saveFile(blob, filename){
  {
    { const u=URL.createObjectURL(blob), a=document.createElement("a"); a.href=u; a.download=filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(u),4000); toast("Fichier téléchargé"); return; }
  }
}
const docName = (o,kind) => (kind==="devis"?"Devis-":kind==="facture"?"Facture-":"Facture-arrivee-") + o.id;

function msgFor(o, kind){
  const S=db.settings, lines=docLines(o,kind), total=sum(lines), rest=Math.max(0,total-(o.paid||0));
  if(kind==="devis") return `Bonjour ${o.client.name},\nVotre devis pour la commande ${o.id} (${o.desc}) est prêt.\nTotal : ${money(total)}\n${o.quote?.note?o.quote.note+"\n":""}Le devis est en pièce jointe. Validez-le dans votre espace client.\n${S.name}`;
  if(kind==="facture") return `Bonjour ${o.client.name},\nMerci, votre commande ${o.id} est validée. Voici votre facture ${o.invoice.number}.\nTotal : ${money(total)} · Déjà payé : ${money(o.paid||0)} · Reste : ${money(rest)}\nSuivez votre colis dans votre espace client.\n${S.name}`;
  return `Bonjour ${o.client.name} 👋\nBonne nouvelle : votre colis ${o.id} (${o.desc}) est arrivé au Mali, à Bamako.\nPoids : ${String(o.weightKg).replace(".",",")} kg · Transport : ${money(transportLine(o)?.amount)}\nReste à payer : ${money(rest)}\nVotre facture ${o.finalInvoice.number} est en pièce jointe.\nRetrait : ${S.address}\n${S.name} · ${S.phone}`;
}

/* ---------- DIALOGS ---------- */
const dlg = $("#dlg");
function openDlg(html){ $("#dlgInner").innerHTML = html; if(!dlg.open) dlg.showModal(); }
dlg.addEventListener("click", e=>{ if(e.target===dlg || e.target.closest("[data-close]")) dlg.close(); });

async function openDoc(o, kind, intro){
  const titles={devis:"Devis",facture:"Facture",arrivee:"Facture d'arrivée"};
  const text = msgFor(o,kind);
  openDlg(`<div class="dlg-h"><h2 style="font-size:1.15rem">${titles[kind]} · ${o.id}</h2><button class="btn sm" data-close aria-label="Fermer">×</button></div>
  <div class="dlg-b" style="display:grid;gap:14px">${intro?`<div class="callout ok">${esc(intro)}</div>`:""}<div id="docSlot" class="empty">Création du document…</div>
  ${st.role==="admin"?`<div><div class="lbl" style="margin-bottom:6px">Message WhatsApp pour ${fmtPhone(o.client.phone)}</div><p class="msg">${esc(text)}</p>
  <p class="note">Dans la version finale, ce message et le PDF partent automatiquement sur le WhatsApp du client. Dans ce prototype, téléchargez le PDF ou l'image puis joignez-le dans WhatsApp.</p></div>`:""}</div>
  <div class="dlg-f"><button class="btn" id="dPng">Image PNG</button><button class="btn" id="dPdf">PDF</button>${st.role==="admin"?`<button class="btn" id="dCopy">Copier le message</button><a class="btn wa" href="${waLink(o.client.phone,text)}" target="_blank" rel="noopener">Ouvrir WhatsApp</a>`:""}</div>`);
  const cv = await drawDoc(o, kind);
  const slot = $("#docSlot"); if(!slot) return;
  slot.className=""; slot.innerHTML = `<img class="docimg" alt="${titles[kind]} ${o.id}" src="${cv.toDataURL("image/png")}">`;
  $("#dPng").onclick = async()=> saveFile(await toPNG(cv), docName(o,kind)+".png");
  try{
    const pdfFile = window.__PWA && navigator.canShare ? new File([await toPDF(cv)], docName(o,kind)+".pdf", {type:"application/pdf"}) : null;
    if(pdfFile && navigator.canShare({files:[pdfFile]})){
      const b=document.createElement("button"); b.className="btn wa"; b.textContent="Partager le PDF (WhatsApp…)";
      b.onclick=async()=>{ try{ await navigator.share({files:[pdfFile], text}); }catch(e){} };
      $("#dlg .dlg-f").prepend(b);
    }
  }catch(e){}
  $("#dPdf").onclick = async()=>{ try{ saveFile(await toPDF(cv), docName(o,kind)+".pdf"); }catch(e){ toast("Le module PDF n'a pas chargé"); } };
  const cp=$("#dCopy"); if(cp) cp.onclick = ()=>copy(text);
}

function newOrderDlg(forPhone){
  const admin = st.role==="admin";
  const c = getClient(forPhone || st.session) || db.clients[0];
  const items = [{photo:null,desc:"",qty:1,link:""}];
  const camSvg = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h4l2-3h6l2 3h4v13H3z"/><circle cx="12" cy="13" r="4"/></svg>`;
  openDlg(`<form id="nf"><div class="dlg-h"><div><h2 style="font-size:1.2rem">${admin?"Nouvelle commande pour un client":"Nouvelle commande"}</h2><div class="note">Ajoutez autant d'articles que vous voulez : un seul devis pour tout.</div></div><button type="button" class="btn sm" data-close aria-label="Fermer">×</button></div>
  <div class="dlg-b" style="display:grid;gap:16px">
    ${admin?`<label class="f">Client<select id="nf-client">${db.clients.map(x=>`<option value="${x.phone}" ${x.phone===c.phone?"selected":""}>${esc(x.name)} · ${fmtPhone(x.phone)}</option>`).join("")}</select></label>`:""}
    <label class="f">Pays d'achat<select id="nf-origin">${ORIGINS.map(x=>`<option>${x}</option>`).join("")}</select></label>
    <div id="nf-items" style="display:grid;gap:12px"></div>
    <button type="button" class="btn" id="nf-add" style="border-style:dashed">+ Ajouter un autre article</button>
  </div>
  <div class="dlg-f"><span class="note" id="nf-count" style="margin-right:auto;align-self:center"></span><button type="button" class="btn" data-close>Annuler</button><button class="btn primary" type="submit">${admin?"Créer la commande":"Envoyer ma demande"}</button></div></form>`);
  const box=$("#nf-items");
  const draw=()=>{
    box.innerHTML = items.map((it,i)=>`<div class="itemcard">
      <label class="upload mini" for="nf-photo-${i}">${it.photo?`<img src="${it.photo}" alt="Photo article ${i+1}">`:`${camSvg}<span>Photo</span>`}</label>
      <input type="file" id="nf-photo-${i}" data-i="${i}" accept="image/*" hidden>
      <div style="display:grid;gap:8px;min-width:0">
        <div class="row" style="justify-content:space-between"><b>Article ${i+1}</b>${items.length>1?`<button type="button" class="btn sm ghost danger" data-rm="${i}">Retirer</button>`:""}</div>
        <textarea id="nf-desc-${i}" data-i="${i}" data-k="desc" rows="2" style="min-height:58px" placeholder="Ex. : Sac à main noir, taille moyenne" required>${esc(it.desc)}</textarea>
        <div class="grid2" style="grid-template-columns:110px minmax(0,1fr)"><input type="number" id="nf-qty-${i}" data-i="${i}" data-k="qty" min="1" value="${it.qty}" aria-label="Quantité article ${i+1}"><input type="text" id="nf-link-${i}" data-i="${i}" data-k="link" value="${esc(it.link)}" placeholder="Lien (facultatif)" aria-label="Lien article ${i+1}"></div>
      </div></div>`).join("");
    $("#nf-count").textContent = items.length>1 ? `${items.length} articles dans cette demande` : "";
  };
  draw();
  box.addEventListener("input",e=>{ const i=e.target.dataset.i, k=e.target.dataset.k; if(i!==undefined && k) items[i][k]= k==="qty" ? Math.max(1,+e.target.value||1) : e.target.value; });
  box.addEventListener("click",e=>{ const r=e.target.closest("[data-rm]"); if(r){ items.splice(+r.dataset.rm,1); draw(); } });
  box.addEventListener("change",e=>{
    if(e.target.type!=="file") return; const i=+e.target.dataset.i, f=e.target.files[0]; if(!f) return;
    const r = new FileReader();
    r.onload = () => { const img = new Image(); img.onload = () => { const s = Math.min(1, 500/Math.max(img.width,img.height)); const cv = document.createElement("canvas"); cv.width = img.width*s; cv.height = img.height*s; cv.getContext("2d").drawImage(img,0,0,cv.width,cv.height); items[i].photo = cv.toDataURL("image/jpeg",.78); draw(); }; img.src = r.result; };
    r.readAsDataURL(f);
  });
  $("#nf-add").onclick=()=>{ items.push({photo:null,desc:"",qty:1,link:""}); draw(); $("#nf-desc-"+(items.length-1))?.focus(); };
  $("#nf").onsubmit = async (e) => {
    e.preventDefault();
    const its = items.filter(it=>it.desc.trim()).map(it=>({photo:it.photo,desc:it.desc.trim(),qty:it.qty,link:it.link.trim()}));
    if(!its.length){ toast("Décrivez au moins un article"); return; }
    const cl = getClient(admin ? $("#nf-client").value : st.session);
    const btn = e.submitter || $("#nf button[type=submit]"); btn.disabled = true; btn.textContent = "Envoi…";
    let created;
    const ok = await act(async()=>{ created = await api.createOrder({clientId:cl.id, origin:$("#nf-origin").value, items:its}); },
      admin ? "Commande créée. Préparez le devis." : `Demande envoyée (${its.length} article${its.length>1?"s":""}). Vous recevrez le devis ici et sur WhatsApp.`);
    if(ok){ st.view="orders"; st.sel=created.ref; dlg.close(); render(); } else { btn.disabled=false; btn.textContent="Réessayer"; }
  };
}

function lotDlg(forOrder){
  const o = forOrder ? db.orders.find(x=>x.id===forOrder) : null;
  const open = db.lots.filter(l=>l.status==="chargement" && (!o || l.origin===o.origin));
  openDlg(`<form id="lf"><div class="dlg-h"><h2 style="font-size:1.15rem">${o?"Mettre "+o.id+" dans un arrivage":"Nouvel arrivage"}</h2><button type="button" class="btn sm" data-close aria-label="Fermer">×</button></div>
  <div class="dlg-b" style="display:grid;gap:14px">
    ${o && open.length ? `<label class="f">Arrivage en préparation<select id="lf-existing"><option value="">+ Créer un nouvel arrivage</option>${open.map(l=>`<option value="${l.id}">${l.id} · ${l.origin} · ${l.mode}</option>`).join("")}</select></label>`:""}
    <div id="lf-new" class="grid3">
      <label class="f">Origine<select id="lf-origin">${ORIGINS.map(x=>`<option ${o&&o.origin===x?"selected":""}>${x}</option>`).join("")}</select></label>
      <label class="f">Mode<select id="lf-mode">${MODES.map(x=>`<option>${x}</option>`).join("")}</select></label>
      <label class="f">Tarif FCFA / kg<input type="number" id="lf-rate" min="0" step="100" value="${db.settings.rates[o?o.origin:ORIGINS[0]]||0}"></label>
    </div>
    <p class="note" style="margin:0">Un arrivage regroupe tous les colis qui voyagent ensemble. À l'arrivée au Mali, vous saisissez le poids de chaque colis et tous les clients reçoivent leur facture d'un coup.</p>
  </div>
  <div class="dlg-f"><button type="button" class="btn" data-close>Annuler</button><button class="btn primary" type="submit">Valider</button></div></form>`);
  const ex=$("#lf-existing"); if(ex){ ex.value=open[0].id; $("#lf-new").hidden=true; ex.onchange=()=>$("#lf-new").hidden=!!ex.value; }
  $("#lf-origin").onchange = e => $("#lf-rate").value = db.settings.rates[e.target.value]||0;
  $("#lf").onsubmit = async e => {
    e.preventDefault();
    let ref;
    const ok = await act(async()=>{
      let lot = ex && ex.value ? getLot(ex.value) : null;
      let lotId = lot?.dbId; ref = lot?.id;
      if(!lot){ const c = await api.createLot({origin:$("#lf-origin").value, mode:$("#lf-mode").value, rate:+$("#lf-rate").value||0}); lotId=c.id; ref=c.ref; }
      if(o) await api.assignLot(o.dbId, lotId);
    });
    if(ok){ dlg.close(); st.view="lots"; st.sel=ref; render(); toast(o?`${o.id} ajouté à ${ref}`:`${ref} créé`); }
  };
}

function arrivalDlg(lot){
  const os = db.orders.filter(o=>o.lot===lot.id);
  const rows = () => os.map(o=>{ const kg=+($("#kg-"+o.id)?.value||o.weightKg||0); const tr=Math.round(kg*lot.rate); const tot=sum(o.quote.lines)+tr; return {o,kg,tr,rest:Math.max(0,tot-(o.paid||0))}; });
  openDlg(`<form id="af"><div class="dlg-h"><h2 style="font-size:1.15rem">Arrivée de ${lot.id} au Mali</h2><button type="button" class="btn sm" data-close aria-label="Fermer">×</button></div>
  <div class="dlg-b" style="display:grid;gap:14px">
    <p style="margin:0">Pesez chaque colis et saisissez son poids. Le transport se calcule à <b>${money(lot.rate)} / kg</b>.</p>
    <div class="tbl-wrap"><table class="grid"><thead><tr><th>Colis</th><th>Client</th><th class="n">Poids (kg)</th><th class="n">Transport</th><th class="n">Reste à payer</th></tr></thead><tbody>
    ${os.map(o=>`<tr><td><span class="ref">${o.id}</span><br><span class="note">${esc(o.desc.slice(0,32))}</span></td><td>${esc(o.client.name)}</td><td class="n"><input type="number" step="0.1" min="0" id="kg-${o.id}" value="${o.weightKg??""}" required aria-label="Poids ${o.id}"></td><td class="n" id="tr-${o.id}">—</td><td class="n" id="rs-${o.id}">—</td></tr>`).join("")}
    </tbody></table></div>
    <div class="row" style="justify-content:space-between"><span class="note" id="afSum"></span></div>
    <div class="callout">En validant : chaque colis passe à « Arrivé au Mali », une facture d'arrivée est générée pour chaque client, et chaque client est prévenu (dans son espace + message WhatsApp avec la facture).</div>
  </div>
  <div class="dlg-f"><button type="button" class="btn" data-close>Annuler</button><button class="btn wa" type="submit">Valider l'arrivée et prévenir les ${os.length} clients</button></div></form>`);
  const upd = () => { let t=0,k=0; rows().forEach(r=>{ $("#tr-"+r.o.id).textContent = r.kg?money(r.tr):"—"; $("#rs-"+r.o.id).textContent = r.kg?money(r.rest):"—"; t+=r.tr; k+=r.kg; }); $("#afSum").textContent = `Total : ${String(Math.round(k*10)/10).replace(".",",")} kg · ${money(t)} de transport`; };
  $("#af").addEventListener("input", upd); upd();
  $("#af").onsubmit = async e => {
    e.preventDefault();
    const rs = rows(); if(rs.some(r=>!r.kg)){ toast("Saisissez le poids de chaque colis"); return; }
    const weights = Object.fromEntries(rs.map(r=>[String(r.o.dbId), r.kg]));
    const ok = await act(()=>api.lotArrive(lot.dbId, weights));
    if(ok) sendReport(getLot(lot.id));
  };
}

async function sendReport(lot){
  const os = db.orders.filter(o=>o.lot===lot.id && o.finalInvoice);
  openDlg(`<div class="dlg-h"><h2 style="font-size:1.15rem">Factures d'arrivée · ${lot.id}</h2><button class="btn sm" data-close aria-label="Fermer">×</button></div>
  <div class="dlg-b"><div class="callout ok">${os.length} clients prévenus dans leur espace. Leurs factures d'arrivée sont prêtes.</div>
  <div id="sendList">${os.map(o=>`<div class="sendrow" data-o="${o.id}"><img alt="" id="th-${o.id}" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><div style="min-width:0"><b>${esc(o.client.name)}</b> <span class="ref">${o.id}</span><div class="note">${fmtPhone(o.client.phone)} · ${String(o.weightKg).replace(".",",")} kg · reste ${money(Math.max(0,grand(o)-(o.paid||0)))}</div><div class="note">✓ Prévenu dans l'application · WhatsApp : envoi automatique dans la version finale</div></div>
  <div class="acts"><button class="btn sm" data-view="${o.id}">Voir</button><button class="btn sm" data-pdf="${o.id}">PDF</button><a class="btn sm wa" target="_blank" rel="noopener" href="${waLink(o.client.phone,msgFor(o,"arrivee"))}">WhatsApp</a></div></div>`).join("")}</div>
  <p class="note">Avec l'API WhatsApp Business, ces ${os.length} messages partent seuls, chacun avec la facture PDF du client.</p></div>
  <div class="dlg-f"><button class="btn primary" data-close>Terminé</button></div>`);
  for(const o of os){ const cv = await drawDoc(o,"arrivee"); const t=$("#th-"+o.id); if(t) t.src = cv.toDataURL("image/jpeg",.7); }
  $("#sendList").onclick = async e => {
    const v=e.target.dataset.view, p=e.target.dataset.pdf;
    if(v) openDoc(db.orders.find(x=>x.id===v),"arrivee");
    if(p){ const o=db.orders.find(x=>x.id===p); try{ saveFile(await toPDF(await drawDoc(o,"arrivee")), docName(o,"arrivee")+".pdf"); }catch(err){ toast("Le module PDF n'a pas chargé"); } }
  };
}

/* ---------- ICONS ---------- */
const I = {
  box:'<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  bell:'<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  user:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users:'<circle cx="9" cy="8" r="4"/><path d="M1.5 21a7.5 7.5 0 0 1 15 0"/><path d="M16 4.2a4 4 0 0 1 0 7.6M22.5 21a7.5 7.5 0 0 0-4.5-6.9"/>',
  truck:'<path d="M1 5h13v11H1zM14 9h4l4 4v3h-8"/><circle cx="5.5" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/>',
  plane:'<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  ship:'<path d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1 .6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M19.4 17.9 21 13H3l1.5 5"/><path d="M12 3v10M6 13V8h12v5"/>',
  store:'<path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M10 20v-5h4v5"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  check:'<path d="M20 6 9 17l-5-5"/>',
  bag:'<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/>',
  pin:'<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  home:'<path d="M3 10.5 12 3l9 7.5V21H3z"/><path d="M9 21v-6h6v6"/>',
  file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  wallet:'<path d="M20 7H5a2 2 0 0 1 0-4h13v4"/><path d="M3 5v14a2 2 0 0 0 2 2h15V7"/><circle cx="16" cy="14" r="1.5"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  camera:'<path d="M3 7h4l2-3h6l2 3h4v13H3z"/><circle cx="12" cy="13" r="4"/>',
  logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  chat:'<path d="M3 21l1.7-5A8.5 8.5 0 1 1 8 19.4z"/>',
  scale:'<path d="M12 3v18M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0zM8 21h8"/>',
  trend:'<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>'
};
const ic=(n,s=18)=>`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]||""}</svg>`;
const modeIc=(m)=>m==="Maritime"?"ship":m==="Route"?"truck":"plane";
const STAGE_IC=["check","bag",null,"pin","home"];
const firstName=(n)=>String(n).split(" ")[0];
const compact=(n)=>new Intl.NumberFormat("fr-FR",{notation:"compact",maximumFractionDigits:1}).format(n);
const emptyBox=(icon,title,text,btn="")=>`<div class="empty"><div class="eic">${ic(icon,28)}</div><h3>${title}</h3><div>${text}</div>${btn}</div>`;
function segs(o){ if(o.status!=="valide") return ""; const s=lastStage(o); return `<span class="segs" aria-label="Étape ${s+1} sur 5">${STAGES.map((_,i)=>`<i class="${i<=s?"on":""}"></i>`).join("")}</span>`; }
function tripLine(o, cls="tline"){
  const s=Math.max(0,lastStage(o)); const pct=[4,12,55,96,96][s]; const lot=getLot(o.lot);
  return `<div class="${cls}"><span class="done" style="width:calc(${pct}% - 6px)"></span><span class="veh" style="left:${pct}%">${ic(s>=3?"pin":modeIc(lot?.mode),14)}</span></div>`;
}

/* ---------- AUTH (client) ---------- */
function renderAuth(mode="login"){
  const S=db.settings;
  $("#auth").innerHTML = `<div class="authwrap">
  <section class="ahero">
    <div class="alogo"><img src="${LOGO_FULL}" alt="${esc(S.name)} : on commande pour les gens partout en Afrique"></div>
    <div class="origins">${ORIGINS.map(o=>`<span>${o}</span>`).join("")}<span>→ Mali</span></div>
    <h1>Vos achats de Chine et d'Afrique de l'Ouest, <em>livrés au Mali.</em></h1>
    <p>Envoyez la photo de l'article, recevez votre devis et suivez votre colis jusqu'à Bamako.</p>
    <ol class="steps">
      <li><span class="si">${ic("camera",22)}</span><div><b>1. Envoyez la photo</b><span>Une capture Alibaba, un catalogue, ce que vous voulez</span></div></li>
      <li><span class="si">${ic("file",22)}</span><div><b>2. Recevez le devis</b><span>Dans l'application et sur votre WhatsApp</span></div></li>
      <li><span class="si">${ic("plane",22)}</span><div><b>3. Suivez votre colis</b><span>Prévenu dès son arrivée au Mali</span></div></li>
    </ol>
  </section>
  <section class="acard">
    <div class="atabs" role="tablist"><button role="tab" aria-selected="${mode==="login"}" data-auth="login">Se connecter</button><button role="tab" aria-selected="${mode==="signup"}" data-auth="signup">Créer un compte</button></div>
    <form id="authForm">
      <div><h2 style="font-size:1.5rem">${mode==="login"?"Bon retour 👋":"Créez votre espace"}</h2><p class="note" style="margin:6px 0 0;font-size:.88rem">${mode==="login"?"Connectez-vous pour suivre vos commandes et vos colis.":"C'est gratuit et ça prend une minute."}</p></div>
      ${mode==="signup"?`<label class="f">Nom complet<input type="text" id="au-name" required autocomplete="name" placeholder="Ex. : Aminata Traoré"></label>`:""}
      <label class="f">Numéro WhatsApp<input type="tel" id="au-phone" required placeholder="76 11 22 33" autocomplete="tel"></label>
      ${mode==="signup"?`<label class="f">Ville<input type="text" id="au-city" value="Bamako"></label>`:""}
      <label class="f">Mot de passe<input type="password" id="au-pwd" required minlength="6" autocomplete="${mode==="login"?"current-password":"new-password"}"></label>
      <p class="note" id="au-err" style="color:var(--bad);margin:0" hidden></p>
      <button class="btn primary" type="submit" style="padding:13px">${mode==="login"?"Se connecter":"Créer mon compte"}</button>
      <button type="button" class="install" data-act="install" ${installable?"":"hidden"}>Installer l'application sur mon téléphone</button>

    </form>
  </section></div>`;
  $("#authForm").onsubmit = async e => {
    e.preventDefault();
    const phone = normPhone($("#au-phone").value), pwd=$("#au-pwd").value, err=$("#au-err"), btn=$("#authForm button[type=submit]");
    err.hidden=true;
    if(phone.length<11){ err.textContent="Numéro WhatsApp invalide (8 chiffres au Mali)."; err.hidden=false; return; }
    btn.disabled=true; const label=btn.textContent; btn.textContent="Patientez…";
    try{
      if(mode==="login") await api.signIn(phone, pwd);
      else { await api.signUp({full_name:$("#au-name").value.trim(), phone, city:$("#au-city").value.trim(), password:pwd}); toast("Compte créé. Bienvenue !"); }
      await boot();
    }catch(ex){ err.textContent=ex.message||"Erreur réseau : réessayez."; err.hidden=false; btn.disabled=false; btn.textContent=label; }
  };
}
async function logout(){ await api.signOut(); me=null; st.session=null; st.sel=null; st.view="orders"; db.orders=[]; db.clients=[]; db.lots=[]; db.notifs=[]; render(); }

/* ---------- NAV + PAGE HEAD ---------- */
function navItems(){
  if(st.role==="client"){ const un=db.notifs.filter(n=>n.phone===st.session && !n.read).length; return [["orders","Mes commandes","box",0],["notifs","Notifications","bell",un],["profile","Mon profil","user",0]]; }
  return [["orders","Commandes","box",db.orders.filter(o=>o.status==="demande").length],["clients","Clients","users",0],["lots","Arrivages","plane",db.lots.filter(l=>l.status==="transit").length],["settings","Mon entreprise","store",0]];
}
function renderNav(hidden){
  const items = hidden ? [] : navItems();
  $("#nav").innerHTML = items.map(([k,t,i,b])=>`<button data-nav="${k}" aria-current="${st.view===k}">${ic(i,20)}<span>${t}</span>${b?`<span class="badge">${b}</span>`:""}</button>`).join("");
  $("#bnav").innerHTML = items.map(([k,t,i,b])=>`<button data-nav="${k}" aria-current="${st.view===k}"><span class="bi">${ic(i,20)}</span>${t.replace("Mes commandes","Commandes").replace("Mon entreprise","Entreprise").replace("Mon profil","Profil")}${b?`<span class="badge">${b}</span>`:""}</button>`).join("");
  $("#bnav").hidden = hidden;
  document.querySelectorAll("[data-role]").forEach(b=>b.setAttribute("aria-pressed", b.dataset.role===st.role));
}
function renderHead(){
  const ph=$("#phead"), hero=$("#hero"); let h="", hr="";
  if(st.role==="client"){
    const c=getClient(st.session), os=db.orders.filter(o=>o.client.phone===st.session);
    if(st.view==="orders"){
      const moving=os.filter(o=>o.status==="valide" && lastStage(o)>=1 && lastStage(o)<4), toVal=os.filter(o=>o.status==="devis").length, wait=os.filter(o=>o.status==="demande").length;
      const live = moving.sort((a,b)=>lastStage(b)-lastStage(a))[0];
      hr = `<section class="hero"><div><h1>Bonjour ${esc(firstName(c.name))} 👋</h1><p>Envoyez la photo de ce que vous voulez acheter. On s'occupe du reste, jusqu'à Bamako.</p>
        <div class="chips"><span><b>${moving.length}</b> colis en route</span><span><b>${toVal}</b> devis à valider</span><span><b>${wait}</b> demande${wait>1?"s":""} en attente</span></div>
        <button class="btn sun" data-act="new">${ic("camera")} Nouvelle commande</button></div>
        ${live?`<div class="trip" data-goorder="${live.id}" style="cursor:pointer"><div class="top"><span>Colis en cours · <span style="font-family:var(--f-mono)">${live.id}</span></span><span>${esc(STAGES[lastStage(live)])}</span></div>
          <div class="ends"><div><small>Départ</small><b>${esc(live.origin.replace(" (Togo)",""))}</b></div><div style="text-align:right"><small>Arrivée</small><b>Bamako</b></div></div>${tripLine(live)}
          <div style="font-size:.85rem;color:rgba(255,255,255,.8)">${esc(live.desc)}</div></div>`
        :`<div class="trip"><div class="top"><span>Aucun colis en route</span></div><div class="ends"><div><small>Départ</small><b>Chine</b></div><div style="text-align:right"><small>Arrivée</small><b>Bamako</b></div></div><div class="tline"><span class="e" style="left:0"></span><span class="e" style="right:0"></span></div><div style="font-size:.85rem;color:rgba(255,255,255,.75)">Votre prochain colis apparaîtra ici.</div></div>`}
      </section>`;
    }
    if(st.view==="notifs") h=`<div class="phead"><div><h1>Notifications</h1><p>Vos devis, factures et arrivées de colis.</p></div></div>`;
    if(st.view==="profile") h=`<div class="phead"><div><h1>Mon profil</h1><p>Vos informations de contact.</p></div></div>`;
  } else {
    const val=db.orders.filter(o=>o.status==="valide");
    if(st.view==="orders"){
      h=`<div class="phead"><div><h1>Commandes</h1><p>Toutes les demandes de vos clients, du devis à la livraison.</p></div><button class="btn primary" data-act="new">${ic("plus")} Nouvelle commande</button></div>`;
      hr=`<div class="kpis">
        <div class="kpi k1"><span class="ki">${ic("clock",22)}</span><b>${db.orders.filter(o=>o.status==="demande").length}</b><span>Demandes à chiffrer</span></div>
        <div class="kpi k2"><span class="ki">${ic("plane",22)}</span><b>${val.filter(o=>lastStage(o)<MALI).length}</b><span>Colis en cours</span></div>
        <div class="kpi k3"><span class="ki">${ic("trend",22)}</span><b>${compact(val.reduce((a,o)=>a+grand(o),0))}</b><span>FCFA facturés</span></div>
        <div class="kpi k4"><span class="ki">${ic("wallet",22)}</span><b>${compact(val.reduce((a,o)=>a+Math.max(0,grand(o)-(o.paid||0)),0))}</b><span>FCFA à encaisser</span></div></div>`;
    }
    if(st.view==="clients") h=`<div class="phead"><div><h1>Clients</h1><p>${db.clients.length} comptes clients. Touchez un client pour voir tout son historique.</p></div></div>`;
    if(st.view==="lots") h=`<div class="phead"><div><h1>Arrivages</h1><p>Regroupez les colis qui voyagent ensemble. À l'arrivée, pesez-les et prévenez tout le monde d'un coup.</p></div><button class="btn primary" data-act="newlot">${ic("plus")} Nouvel arrivage</button></div>`;
    if(st.view==="settings") h=`<div class="phead"><div><h1>Mon entreprise</h1><p>Votre logo, vos couleurs et vos tarifs apparaissent sur tous les devis et factures.</p></div></div>`;
  }
  ph.innerHTML=h; ph.hidden=!h; hero.innerHTML=hr; hero.hidden=!hr;
}

/* ---------- LIST ---------- */
function orderItem(o){ const n=o.items?.length||1; return `<li class="item" data-sel="${o.id}" aria-current="${o.id===st.sel}" tabindex="0"><span class="tstack"><img class="thumb" src="${o.photo}" alt="">${n>1?`<span class="tcount">${n}</span>`:""}</span><div style="min-width:0"><div class="t">${esc(o.desc)}</div><div class="m"><span class="ref">${o.id}</span>${st.role==="admin"?`<span>${esc(o.client.name)}</span>`:""}<span>${esc(o.origin)}</span></div><div class="row2">${pill(o)}${segs(o)}</div></div></li>`; }
function renderList(){
  const head=$("#listHead"), body=$("#listBody"); let h="", b="";
  if(st.role==="client"){
    if(st.view==="orders"){ const os=db.orders.filter(o=>o.client.phone===st.session); h=`<div class="panel-h"><h2>Mes commandes</h2><span class="note">${os.length} au total</span></div>`; b = os.length?`<ul class="list">${os.map(orderItem).join("")}</ul>`:emptyBox("camera","Pas encore de commande","Envoyez la photo d'un article pour recevoir votre devis.",`<button class="btn primary" data-act="new">${ic("camera")} Envoyer une photo</button>`); }
    if(st.view==="notifs"){ const ns=db.notifs.filter(n=>n.phone===st.session); b = ns.length?`<ul class="list">${ns.map(n=>{ const o=db.orders.find(x=>x.id===n.orderId); return `<li class="item ${n.read?"":"unread"}" data-notif="${n.id}" tabindex="0"><img class="thumb" src="${o?.photo||""}" alt=""><div style="min-width:0"><div class="t">${n.kind==="arrivee"?"Colis arrivé au Mali":n.kind==="devis"?"Nouveau devis":"Facture disponible"}</div><div class="m">${esc(n.text)}</div><div class="m">${ftime(n.date)}</div></div></li>`; }).join("")}</ul>`:emptyBox("bell","Aucune notification","Vos devis et arrivées de colis apparaîtront ici."); }
    if(st.view==="profile"){ const c=getClient(st.session); const os=db.orders.filter(o=>o.client.phone===c.phone); b=`<div class="panel-b" style="display:grid;justify-items:center;gap:10px;text-align:center;padding:32px 20px"><div class="avatar" style="width:84px;height:84px;font-size:1.8rem">${initials(c.name)}</div><h2>${esc(c.name)}</h2><div class="note">Client depuis le ${fdate(c.createdAt)}</div><div class="stats" style="width:100%;padding:8px 0 0;grid-template-columns:repeat(2,minmax(0,1fr))"><div><b>${os.length}</b><span>Commandes</span></div><div><b>${os.filter(o=>lastStage(o)>=MALI).length}</b><span>Colis reçus</span></div></div></div>`; }
  } else {
    if(st.view==="orders"){
      const os = db.orders.filter(o => st.filter==="tous" ? true : st.filter==="chiffrer" ? o.status==="demande" : st.filter==="devis" ? o.status==="devis" : st.filter==="expedier" ? (o.status==="valide" && lastStage(o)===1 && !o.lot) : st.filter==="route" ? (o.status==="valide" && lastStage(o)>=1 && lastStage(o)<MALI) : st.filter==="arrive" ? lastStage(o)>=MALI : true);
      h = `<div class="filters">${[["tous","Toutes"],["chiffrer","À chiffrer"],["devis","Devis envoyés"],["expedier","À expédier"],["route","En cours"],["arrive","Arrivées"]].map(([k,t])=>`<button class="chip" data-f="${k}" aria-pressed="${st.filter===k}">${t}</button>`).join("")}</div>`;
      b = os.length?`<ul class="list">${os.map(orderItem).join("")}</ul>`:emptyBox("box","Rien ici","Aucune commande dans ce filtre.");
    }
    if(st.view==="clients"){
      b=`<ul class="list">${db.clients.map(c=>{ const os=db.orders.filter(o=>o.client.phone===c.phone); return `<li class="item" data-sel="${c.phone}" aria-current="${c.phone===st.sel}" tabindex="0"><div class="avatar" style="width:56px;height:56px">${initials(c.name)}</div><div style="min-width:0"><div class="t">${esc(c.name)}</div><div class="m"><span>${fmtPhone(c.phone)}</span><span>${esc(c.city||"")}</span></div><div class="m" style="margin-top:4px"><span class="pill p-quote">${os.length} commande${os.length>1?"s":""}</span><span>${money(os.filter(o=>o.status==="valide").reduce((a,o)=>a+grand(o),0))}</span></div></div></li>`; }).join("")}</ul>`;
    }
    if(st.view==="lots"){
      b=`<ul class="list">${db.lots.map(l=>{ const n=db.orders.filter(o=>o.lot===l.id).length; return `<li class="item" data-sel="${l.id}" aria-current="${l.id===st.sel}" tabindex="0"><div class="lotic">${ic(modeIc(l.mode),24)}</div><div style="min-width:0"><div class="t">${l.id} · ${esc(l.origin)}</div><div class="m"><span>${l.mode}</span><span>${n} colis</span><span>${money(l.rate)}/kg</span></div><div class="row2">${lotPill(l)}</div></div></li>`; }).join("")}</ul>`;
    }
    if(st.view==="settings"){ h=`<div class="panel-h"><h2>Aperçu en direct</h2><span class="note">Facture d'arrivée</span></div>`; b=`<div class="panel-b"><img class="preview-doc" id="prevDoc" alt="Aperçu de facture avec votre logo"></div>`; }
  }
  head.innerHTML=h; body.innerHTML=b;
  if(st.view==="settings") refreshPreview();
}

/* ---------- DETAIL ---------- */
function renderDetail(){
  const el=$("#detail");
  if(st.role==="client" && st.view==="profile") return profileDetail(el);
  if(st.role==="admin" && st.view==="settings") return settingsDetail(el);
  if(st.role==="admin" && st.view==="clients"){ const c=getClient(st.sel); return c ? clientDetail(el,c) : el.innerHTML=emptyBox("users","Choisissez un client","Vous verrez ses commandes, ce qu'il a payé et ce qu'il doit encore."); }
  if(st.role==="admin" && st.view==="lots"){ const l=getLot(st.sel); return l ? lotDetail(el,l) : el.innerHTML=emptyBox("plane","Choisissez un arrivage","Un arrivage regroupe les colis qui voyagent ensemble jusqu'au Mali."); }
  if(st.view==="notifs"){ el.innerHTML=emptyBox("file","Vos documents","Touchez une notification pour ouvrir le devis ou la facture."); return; }
  const o = db.orders.find(x=>x.id===st.sel && (st.role==="admin" || x.client.phone===st.session));
  if(!o){ el.innerHTML = st.role==="client" ? emptyBox("box","Choisissez une commande","Ou envoyez la photo d'un nouvel article.",`<button class="btn primary" data-act="new">${ic("camera")} Nouvelle commande</button>`) : emptyBox("box","Choisissez une commande","Les nouvelles demandes arrivent dans « À chiffrer »."); return; }
  orderDetail(el,o);
}

function orderDetail(el,o){
  const admin=st.role==="admin", q=o.quote, s=lastStage(o), lot=getLot(o.lot);
  let h = `<div class="dhero"><img class="photo" src="${o.photo}" alt="Photo envoyée par le client"><div style="min-width:0">
    <div class="row" style="justify-content:space-between"><span class="ref">${o.id} · ${fdate(o.createdAt)}</span>${pill(o)}</div>
    <h2>${esc(o.desc)}</h2>
    <dl class="kv"><dt>Client</dt><dd>${admin?`<button class="btn sm" data-goclient="${o.client.phone}">${esc(o.client.name)}</button>`:esc(o.client.name)}</dd><dt>WhatsApp</dt><dd>${fmtPhone(o.client.phone)}</dd><dt>${o.items&&o.items.length>1?"Articles":"Quantité"}</dt><dd>${o.items&&o.items.length>1?`${o.items.length} articles · ${o.qty} pièces`:o.qty}</dd>${o.weightKg!=null?`<dt>Poids</dt><dd>${String(o.weightKg).replace(".",",")} kg</dd>`:""}${lot&&admin?`<dt>Arrivage</dt><dd><button class="btn sm" data-golot="${lot.id}">${ic(modeIc(lot.mode),14)} ${lot.id}</button></dd>`:""}${o.link?`<dt>Lien</dt><dd>${esc(o.link)}</dd>`:""}</dl>
    <div class="route"><div><small>Départ</small><b>${esc(o.origin.replace(" (Togo)",""))}</b></div>${o.status==="valide"?tripLine(o,"rline"):`<div class="rline"></div>`}<div style="text-align:right"><small>Arrivée</small><b>Bamako</b></div></div>
  </div></div>
  ${o.items && o.items.length>1?`<div class="section"><h3>${ic("bag")} ${o.items.length} articles dans cette commande</h3><div class="gallery">${o.items.map((it,i)=>`<figure><img src="${it.photo}" alt="Article ${i+1}"><figcaption><b>${esc(it.desc)}</b><span>Quantité : ${it.qty}${it.link?` · ${esc(it.link)}`:""}</span></figcaption></figure>`).join("")}</div></div>`:""}`;

  if(o.status==="demande"){
    h += admin ? `<div class="section"><h3>${ic("file")} Préparer le devis</h3><div id="qlines"></div><button class="btn sm ghost" data-act="addline">${ic("plus",16)} Ajouter une ligne</button>
      <label class="f" style="margin-top:14px">Message pour le client<textarea id="qnote">Transport facturé au poids à l'arrivée (${money(db.settings.rates[o.origin]||0)}/kg).</textarea></label>
      <div class="restbox"><span>Total du devis</span><b id="qtotal"></b></div>
      <div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn primary" data-act="sendquote">${ic("file")} Générer et envoyer le devis</button></div></div>`
      : `<div class="section"><div class="callout">${ic("clock",16)} Votre demande est bien reçue. Vous recevrez le devis ici et sur WhatsApp dès qu'il sera prêt.</div></div>`;
  } else if(q){
    const kind = o.finalInvoice ? "arrivee" : o.invoice ? "facture" : "devis";
    const lines = docLines(o, kind), total=sum(lines), rest=Math.max(0,total-(o.paid||0));
    h += `<div class="section"><h3>${ic("file")} ${kind==="arrivee"?"Facture d'arrivée "+o.finalInvoice.number:kind==="facture"?"Facture "+o.invoice.number:"Devis"}</h3>
    <table class="q">${lines.map(l=>`<tr><td>${esc(l.label)}</td><td>${money(l.amount)}</td></tr>`).join("")}<tr class="total"><td>Total</td><td>${money(total)}</td></tr>
    ${o.invoice?`<tr class="sub"><td>Déjà payé</td><td>− ${money(o.paid||0)}</td></tr>`:""}</table>
    ${o.invoice?`<div class="restbox"><span>Reste à payer</span><b>${money(rest)}</b></div>`:""}
    ${q.note && kind==="devis"?`<p class="note">${esc(q.note)}</p>`:""}
    <div class="row" style="margin-top:14px">`;
    if(o.status==="devis" && !admin) h += `<button class="btn primary" data-act="accept">${ic("check")} Valider le devis</button><button class="btn danger" data-act="refuse">Refuser</button>`;
    h += `<button class="btn" data-doc="devis">Voir le devis</button>`;
    if(o.invoice) h += `<button class="btn ${o.finalInvoice?"":"primary"}" data-doc="facture">Facture</button>`;
    if(o.finalInvoice) h += `<button class="btn sun" data-doc="arrivee">${ic("file")} Facture d'arrivée</button>`;
    if(o.status==="devis" && admin) h += `<span class="note">Envoyé le ${ftime(q.sentAt)}, en attente du client.</span>`;
    if(o.status==="refuse") h += `<span class="note">Le client a refusé ce devis.</span>`;
    h += `</div>`;
    if(o.invoice && o.payments.length) h += `<div style="margin-top:16px"><div class="lbl" style="margin-bottom:6px">Paiements reçus</div><table class="q">${o.payments.map(p=>`<tr><td>${fdate(p.date)} · ${PAY[p.method]||p.method}${p.reference?` <span class="ref">${esc(p.reference)}</span>`:""}</td><td>${money(p.amount)}</td></tr>`).join("")}</table></div>`;
    if(admin && o.invoice) h += `<div class="callout" style="margin-top:14px;display:grid;gap:10px"><b>${ic("wallet",16)} Enregistrer un paiement</b><div class="grid3"><label class="f">Montant (FCFA)<input type="number" id="pay-amount" min="1" step="500" value="${Math.max(0,total-(o.paid||0))||""}"></label><label class="f">Moyen<select id="pay-method">${Object.entries(PAY).map(([k,v])=>`<option value="${k}">${v}</option>`).join("")}</select></label><label class="f">Référence (facultatif)<input type="text" id="pay-ref" placeholder="N° de transaction"></label></div><div><button class="btn primary" data-act="addpay">Enregistrer le paiement</button></div></div>`;
    h += `</div>`;
  }

  if(o.status==="valide"){
    const done=new Map(o.tracking.map(t=>[t.stage,t]));
    h += `<div class="section"><h3>${ic("pin")} Suivi du colis</h3><ol class="track">` + STAGES.map((name,i)=>{
      const t=done.get(i), cls=t?"done":(i===s+1?"next":"");
      let sub = t?ftime(t.date):(i===s+1?"Prochaine étape":"");
      if(i===2 && lot && !t) sub = `Dans ${admin?lot.id:"un envoi"} en préparation`;
      let act="";
      if(admin && i===s+1){
        if(i===1) act=`<button class="btn sm primary" data-stage="1">Marquer acheté</button>`;
        if(i===2) act = lot ? `<button class="btn sm" data-golot="${lot.id}">Gérer ${lot.id}</button>` : `<button class="btn sm primary" data-act="tolot">Mettre dans un arrivage</button>`;
        if(i===3 && lot) act=`<button class="btn sm wa" data-golot="${lot.id}">Arrivée via ${lot.id}</button>`;
        if(i===4) act=`<button class="btn sm primary" data-stage="4">Marquer livré</button>`;
      }
      return `<li class="${cls}"><span class="dot">${ic(t?"check":(STAGE_IC[i]||modeIc(lot?.mode)),18)}</span><div><div class="s">${i===2?`Expédié depuis ${esc(o.origin)}`:name}</div><div class="d">${sub}</div></div>${act}</li>`;
    }).join("") + `</ol>`;
    if(!admin && s===MALI) h += `<div class="callout ok">${ic("pin",16)} Votre colis est arrivé à Bamako. Retrait : ${esc(db.settings.address)}.</div>`;
    h += `</div>`;
  }
  el.innerHTML = h;
  if(o.status==="demande" && admin) setupQuote(o);
}

let qLines=[];
function setupQuote(o){
  qLines=[...(o.items||[{desc:o.desc,qty:o.qty}]).map(it=>({label:`${it.desc.split(",")[0]} (× ${it.qty})`,amount:""})),{label:"Commission achat",amount:""}];
  const draw=()=>{ $("#qlines").innerHTML = qLines.map((l,i)=>`<div class="ql"><input type="text" id="ql-l-${i}" value="${esc(l.label)}" aria-label="Libellé ligne ${i+1}"><input type="number" min="0" step="500" id="ql-a-${i}" value="${l.amount}" placeholder="FCFA" aria-label="Montant ligne ${i+1}"><button class="btn sm ghost" data-del="${i}" aria-label="Supprimer la ligne">×</button></div>`).join(""); tot(); };
  const tot=()=>$("#qtotal").textContent=money(sum(qLines));
  setupQuote.draw=draw; draw();
  $("#qlines").addEventListener("input",e=>{ const m=e.target.id.match(/ql-([la])-(\d+)/); if(!m) return; qLines[m[2]][m[1]==="l"?"label":"amount"]=e.target.value; tot(); });
}

function clientDetail(el,c){
  const os=db.orders.filter(o=>o.client.phone===c.phone), val=os.filter(o=>o.status==="valide");
  el.innerHTML=`<div class="panel-b" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><div class="avatar" style="width:68px;height:68px;font-size:1.4rem">${initials(c.name)}</div><div style="flex:1;min-width:180px"><h2>${esc(c.name)}</h2><div class="note">${fmtPhone(c.phone)} · ${esc(c.city||"")} · client depuis le ${fdate(c.createdAt)}</div></div><div class="row"><a class="btn sm wa" target="_blank" rel="noopener" href="${waLink(c.phone,"Bonjour "+c.name+", ")}">${ic("chat",16)} WhatsApp</a><button class="btn sm primary" data-newfor="${c.phone}">${ic("plus",16)} Commande</button></div></div>
  <div class="stats"><div><b>${os.length}</b><span>Commandes</span></div><div><b>${compact(val.reduce((a,o)=>a+grand(o),0))}</b><span>FCFA facturés</span></div><div><b>${compact(val.reduce((a,o)=>a+Math.max(0,grand(o)-(o.paid||0)),0))}</b><span>FCFA restant dû</span></div></div>
  <div style="border-top:1px solid var(--line)">${os.length?`<ul class="list">${os.map(o=>`<li class="item" data-goorder="${o.id}" tabindex="0"><img class="thumb" src="${o.photo}" alt=""><div style="min-width:0"><div class="t">${esc(o.desc)}</div><div class="m"><span class="ref">${o.id}</span><span>${esc(o.origin)}</span><span>${fdate(o.createdAt)}</span></div><div class="row2">${pill(o)}${segs(o)}</div></div></li>`).join("")}</ul>`:emptyBox("box","Aucune commande","Ce client n'a pas encore commandé.")}</div>`;
}

function lotDetail(el,l){
  const os=db.orders.filter(o=>o.lot===l.id);
  const addable=db.orders.filter(o=>o.status==="valide" && !o.lot && lastStage(o)===1 && o.origin===l.origin);
  const kg=os.reduce((a,o)=>a+(o.weightKg||0),0);
  const pct = l.status==="chargement"?4:l.status==="transit"?55:96;
  let h=`<div class="panel-b"><div class="row" style="justify-content:space-between"><div><h2 style="font-size:1.4rem">${l.id}</h2><div class="note">${l.mode} · ${money(l.rate)}/kg · ${os.length} colis${l.status==="arrive"?` · ${String(Math.round(kg*10)/10).replace(".",",")} kg`:""}</div></div>${lotPill(l)}</div>
  <div class="route"><div><small>Départ ${l.departedAt?"· "+fdate(l.departedAt):""}</small><b>${esc(l.origin.replace(" (Togo)",""))}</b></div><div class="rline"><span class="done" style="width:${pct}%"></span><span class="veh" style="left:${pct}%">${ic(l.status==="arrive"?"pin":modeIc(l.mode),14)}</span></div><div style="text-align:right"><small>Arrivée ${l.arrivedAt?"· "+fdate(l.arrivedAt):""}</small><b>Bamako</b></div></div>
  <div class="row" style="margin-top:16px">`;
  if(l.status==="chargement") h+=`<button class="btn primary" data-act="depart" ${os.length?"":"disabled"}>${ic(modeIc(l.mode))} Confirmer le départ</button>`;
  if(l.status==="transit") h+=`<button class="btn wa" data-act="arrival">${ic("scale")} Colis arrivés au Mali : peser et prévenir</button>`;
  if(l.status==="arrive") h+=`<button class="btn wa" data-act="report">${ic("file")} Revoir les factures envoyées</button>`;
  h+=`</div></div><div class="section"><h3>${ic("box")} Colis dans cet arrivage</h3>`;
  h+= os.length?`<div class="tbl-wrap"><table class="grid"><thead><tr><th>Colis</th><th>Client</th><th>Statut</th><th class="n">Poids</th><th class="n">Reste à payer</th></tr></thead><tbody>${os.map(o=>`<tr data-goorder="${o.id}" style="cursor:pointer" tabindex="0"><td><span class="ref">${o.id}</span><br><span class="note">${esc(o.desc.slice(0,34))}</span></td><td>${esc(o.client.name)}</td><td>${pill(o)}</td><td class="n">${o.weightKg!=null?String(o.weightKg).replace(".",",")+" kg":"—"}</td><td class="n">${money(Math.max(0,grand(o)-(o.paid||0)))}</td></tr>`).join("")}</tbody></table></div>`:`<p class="note">Aucun colis pour l'instant.</p>`;
  h+=`</div>`;
  if(l.status==="chargement"){
    h+=`<div class="section"><h3>${ic("plus")} Ajouter des colis achetés (${esc(l.origin)})</h3>${addable.length?addable.map(o=>`<div class="item" style="cursor:default"><img class="thumb" src="${o.photo}" alt=""><div class="row" style="justify-content:space-between;min-width:0"><div style="min-width:0"><div class="t">${esc(o.desc)}</div><div class="m"><span class="ref">${o.id}</span><span>${esc(o.client.name)}</span></div></div><button class="btn sm" data-addlot="${o.id}">Ajouter</button></div></div>`).join(""):`<p class="note">Aucun colis acheté en attente pour cette origine.</p>`}</div>`;
  }
  el.innerHTML=h;
}

let prevT;
function refreshPreview(){
  clearTimeout(prevT); prevT=setTimeout(async()=>{
    const img=$("#prevDoc"); if(!img) return;
    const sample={id:"CMD-0042",client:{name:"Client exemple",phone:"22376000000"},origin:"Chine",desc:"Article exemple pour l'aperçu",qty:2,photo:ph("Article",260),quote:{lines:[{label:"Articles (2 × 25 000)",amount:50000},{label:"Commission achat",amount:5000}],sentAt:now()},invoice:{number:"FAC-2026-0042",date:now()},finalInvoice:{number:"FAR-2026-0042",date:now()},lot:null,weightKg:3.5,paid:55000};
    const cv=await drawDoc(sample,"arrivee"); img.src=cv.toDataURL("image/jpeg",.85);
  },150);
}
function settingsDetail(el){
  const S=db.settings;
  el.innerHTML=`<form class="panel-b" id="sf" style="display:grid;gap:16px">
    <div class="row"><div class="mark" style="width:76px;height:76px;border-radius:22px">${S.logo?`<img src="${S.logo}" alt="Logo">`:`<b style="font-size:1.5rem;font-family:var(--f-display)">${initials(S.name)}</b>`}</div>
    <div style="display:grid;gap:6px"><b>Logo de l'entreprise</b><div class="row"><label class="btn sm" for="sf-logo">${ic("camera",16)} Changer le logo</label>${S.logoUrl?`<button type="button" class="btn danger sm" data-act="rmlogo">Remettre le logo par défaut</button>`:""}</div></div><input type="file" id="sf-logo" accept="image/*" hidden></div>
    <div class="grid2"><label class="f">Nom de l'entreprise<input type="text" id="sf-name" value="${esc(S.name)}"></label><label class="f">Téléphone / WhatsApp<input type="text" id="sf-phone" value="${esc(S.phone)}"></label></div>
    <label class="f">Slogan<input type="text" id="sf-slogan" value="${esc(S.slogan)}"></label>
    <label class="f">Adresse de retrait<input type="text" id="sf-address" value="${esc(S.address)}"></label>
    <div class="row"><label class="f">Couleur principale<input type="color" id="sf-color" value="${S.color}"></label><label class="f">Couleur secondaire<input type="color" id="sf-accent" value="${S.accent}"></label></div>
    <div><div class="lbl" style="margin-bottom:8px">Tarif transport par défaut (FCFA / kg)</div><div class="grid3">${ORIGINS.map((o,i)=>`<label class="f">${o}<input type="number" min="0" step="100" id="sf-rate-${i}" value="${S.rates[o]||0}"></label>`).join("")}</div><p class="note">Valeurs d'exemple : mettez vos vrais tarifs.</p></div>
    <div><button class="btn primary" type="submit">${ic("check")} Enregistrer</button></div>
  </form>`;
  const live=()=>{ S.name=$("#sf-name").value; S.phone=$("#sf-phone").value; S.slogan=$("#sf-slogan").value; S.address=$("#sf-address").value; S.color=$("#sf-color").value; S.accent=$("#sf-accent").value; ORIGINS.forEach((o,i)=>S.rates[o]=+$("#sf-rate-"+i).value||0); refreshPreview(); };
  $("#sf").addEventListener("input", live);
  $("#sf-logo").onchange=e=>{ const f=e.target.files[0]; if(!f) return; const r=new FileReader(); r.onload=()=>{ const img=new Image(); img.onload=async()=>{ const s=Math.min(1,640/Math.max(img.width,img.height)); const cv=document.createElement("canvas"); cv.width=img.width*s; cv.height=img.height*s; cv.getContext("2d").drawImage(img,0,0,cv.width,cv.height); live(); await act(async()=>{ S.logoUrl = await api.uploadLogo(cv.toDataURL("image/png")); await api.saveSettings(S); }, "Logo mis à jour"); paintTop(); }; img.src=r.result; }; r.readAsDataURL(f); };
  $("#sf").onsubmit=async e=>{ e.preventDefault(); live(); await act(()=>api.saveSettings(S), "Paramètres enregistrés"); paintTop(); };
}
function profileDetail(el){
  const c=getClient(st.session);
  el.innerHTML=`<form class="panel-b" id="pf" style="display:grid;gap:14px">
  <label class="f">Nom complet<input type="text" id="pf-name" value="${esc(c.name)}"></label>
  <label class="f">Numéro WhatsApp<input type="tel" value="${fmtPhone(c.phone)}" disabled></label>
  <label class="f">Ville<input type="text" id="pf-city" value="${esc(c.city||"")}"></label>
  <div class="row"><button class="btn primary" type="submit">${ic("check")} Enregistrer</button><button type="button" class="btn danger" data-act="logout">${ic("logout")} Se déconnecter</button></div></form>`;
  $("#pf").onsubmit=async e=>{ e.preventDefault(); const full_name=$("#pf-name").value.trim()||c.name, city=$("#pf-city").value.trim(); await act(async()=>{ await api.updateProfile(me.id,{full_name,city}); me.full_name=full_name; me.city=city; }, "Profil enregistré"); };
}

/* ---------- EVENTS ---------- */
document.addEventListener("click", async (e) => {
  if(busy) return;
  const t=e.target.closest("button, li.item, tr[data-goorder], .trip[data-goorder]"); if(!t) return;
  const d=t.dataset;
  if(d.auth){ st.authMode=d.auth; renderAuth(d.auth); return; }
  if(d.nav){ st.view=d.nav; st.sel=null; render(); scrollTo({top:0}); return; }
  if(d.sel){ st.sel=d.sel; render(); if(innerWidth<1100) $("#detail").scrollIntoView({behavior:"smooth",block:"start"}); return; }
  if(d.f){ st.filter=d.f; render(); return; }
  if(d.goclient){ st.view="clients"; st.sel=d.goclient; render(); return; }
  if(d.golot){ st.view="lots"; st.sel=d.golot; render(); return; }
  if(d.goorder){ if(t.closest("#dlg")) return; st.view="orders"; st.filter="tous"; st.sel=d.goorder; render(); if(innerWidth<1100) $("#detail").scrollIntoView({behavior:"smooth",block:"start"}); return; }
  if(d.newfor){ newOrderDlg(d.newfor); return; }
  if(d.notif){ const n=db.notifs.find(x=>x.id===d.notif); if(!n.read){ n.read=true; api.markRead(n.dbId).catch(()=>{}); } const o=db.orders.find(x=>x.id===n.orderId); render(); if(o){ const k = n.kind==="arrivee"&&o.finalInvoice?"arrivee":n.kind==="devis"&&o.quote?"devis":o.invoice?"facture":null; if(k) openDoc(o,k); } return; }
  if(d.del!==undefined && setupQuote.draw){ qLines.splice(+d.del,1); setupQuote.draw(); return; }
  if(d.addlot){ const o=db.orders.find(x=>x.id===d.addlot); await act(()=>api.assignLot(o.dbId, getLot(st.sel).dbId), `${o.id} ajouté à l'arrivage`); return; }
  const o = db.orders.find(x=>x.id===st.sel);
  const lot = getLot(st.sel);
  if(d.doc && o){ openDoc(o, d.doc); return; }
  if(d.stage && o){ const s=+d.stage; await act(()=>api.setStage(o.dbId, s), s===4?"Colis marqué livré":"Colis marqué acheté : le client le voit dans son suivi"); return; }
  switch(d.act){
    case "new": newOrderDlg(); break;
    case "newlot": lotDlg(); break;
    case "tolot": lotDlg(o.id); break;
    case "logout": logout(); break;
    case "install": installApp(); break;
    case "rmlogo": db.settings.logoUrl=null; await act(()=>api.saveSettings(db.settings), "Logo par défaut remis"); paintTop(); break;
    case "addline": qLines.push({label:"",amount:""}); setupQuote.draw(); break;
    case "sendquote": {
      const clean=qLines.filter(l=>String(l.label).trim() && +l.amount>0).map(l=>({label:String(l.label).trim(),amount:+l.amount}));
      if(!clean.length){ toast("Ajoutez au moins une ligne avec un montant"); break; }
      const ref=o.id;
      if(await act(()=>api.sendQuote(o.dbId, clean, $("#qnote").value.trim()))){ const fresh=db.orders.find(x=>x.id===ref); if(fresh) openDoc(fresh,"devis","Devis envoyé. Le client le voit déjà dans son espace."); }
      break;
    }
    case "accept": {
      const ref=o.id;
      if(await act(()=>api.respondQuote(o.dbId, true))){ const fresh=db.orders.find(x=>x.id===ref); if(fresh?.invoice) openDoc(fresh,"facture","Devis validé : votre facture est prête."); }
      break;
    }
    case "refuse": await act(()=>api.respondQuote(o.dbId, false), "Devis refusé"); break;
    case "addpay": {
      const amount=Math.round(+$("#pay-amount").value||0);
      if(amount<=0){ toast("Indiquez un montant"); break; }
      await act(()=>api.addPayment(o.dbId, amount, $("#pay-method").value, $("#pay-ref").value.trim()), "Paiement enregistré");
      break;
    }
    case "depart": await act(()=>api.lotDepart(lot.dbId), `${lot.id} est en route : les clients voient « Expédié »`); break;
    case "arrival": arrivalDlg(lot); break;
    case "report": sendReport(lot); break;
  }
});
document.addEventListener("keydown", e=>{ if(e.key==="Enter" && (e.target.matches?.("li.item, tr[data-goorder]"))) e.target.click(); });

/* ---------- PWA install ---------- */
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent), standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
let installable=false;
function showInstall(){ installable=true; document.querySelectorAll("[data-act=install]").forEach(b=>b.hidden=false); }
if(window.__PWA && !standalone && (window.__pwaPrompt || isIOS)) setTimeout(showInstall);
window.addEventListener("pwa-installable", ()=>{ if(!standalone) showInstall(); });
async function installApp(){
  if(window.__pwaPrompt){ window.__pwaPrompt.prompt(); try{ const r=await window.__pwaPrompt.userChoice; if(r.outcome==="accepted"){ toast("Application installée"); document.querySelectorAll("[data-act=install]").forEach(b=>b.hidden=true);} }catch(e){} window.__pwaPrompt=null; return; }
  openDlg(`<div class="dlg-h"><h2 style="font-size:1.15rem">Installer l'application</h2><button class="btn sm" data-close aria-label="Fermer">×</button></div><div class="dlg-b" style="display:grid;gap:12px">
  <p style="margin:0">Sur iPhone, dans Safari :</p><ol style="margin:0;padding-left:20px;display:grid;gap:6px"><li>Touchez le bouton <b>Partager</b> (le carré avec une flèche).</li><li>Choisissez <b>Sur l'écran d'accueil</b>.</li><li>Touchez <b>Ajouter</b>.</li></ol>
  <p class="note" style="margin:0">Sur Android, ouvrez le menu de Chrome (⋮) puis <b>Installer l'application</b>.</p></div>`);
}

function paintTop(){
  const S=db.settings;
  const def = !S.logo || S.logo===LOGO;
  $("#sideLogo").src = def ? LOGO_LIGHT : S.logo; $("#sideCard").classList.toggle("boxed", !def);
  $("#mobLogo").src = def ? LOGO : S.logo; $("#mobLogo").parentElement.classList.toggle("def", def); $("#sideLogo").alt=S.name; $("#mobLogo").alt=S.name;
}
function render(){
  const needAuth = !me;
  $("#loading").hidden = true;
  $("#auth").hidden=!needAuth; $("#app").hidden=needAuth;
  document.body.classList.toggle("is-auth", needAuth); $("#wall").hidden=!needAuth;
  renderNav(needAuth);
  const who=$("#who"), side=$("#sideUser");
  if(needAuth){ who.innerHTML=""; side.innerHTML=""; $("#phead").hidden=true; $("#hero").hidden=true; renderAuth(st.authMode||"login"); return; }
  const userChip = `<div class="avatar" style="width:36px;height:36px;font-size:.82rem">${initials(me.full_name)}</div>`;
  side.innerHTML = `${userChip}<div style="min-width:0;flex:1"><b style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(me.full_name)}</b><span style="font-size:.74rem;opacity:.7">${st.role==="admin"?"Gérant":"Client"}</span></div><button class="btn sm ghost" style="color:#fff" data-act="logout" aria-label="Se déconnecter">${ic("logout",16)}</button>`;
  if(st.role==="client"){ who.innerHTML=`${userChip}<span>${esc(firstName(me.full_name))}</span><button class="btn sm ghost" data-act="logout" aria-label="Se déconnecter">${ic("logout",16)}</button>`;
    if(st.view==="orders" && !st.sel) st.sel = db.orders.find(o=>o.client.phone===st.session)?.id ?? null; }
  else who.innerHTML=`<span class="pill p-new">Espace gérant</span>${userChip}<button class="btn sm ghost" data-act="logout" aria-label="Se déconnecter">${ic("logout",16)}</button>`;
  renderHead(); renderList(); renderDetail();
}

let unsubscribe = null;
async function boot(){
  try{
    me = await api.currentProfile();
    if(!me){ try{ db.settings = await api.loadSettings(); }catch(e){} paintTop(); render(); return; }
    st.role = me.role==="admin" ? "admin" : "client";
    st.session = me.phone;
    db = await api.loadAll(me);
    paintTop(); render();
    unsubscribe?.(); unsubscribe = api.onChanges(()=>reload().catch(()=>{}));
  }catch(e){
    console.error(e);
    $("#loading").hidden=false; $("#loading").innerHTML = `<h3>Connexion au serveur impossible</h3><div>Vérifiez votre connexion internet.</div><button class="btn primary" onclick="location.reload()">Réessayer</button>`;
  }
}
api.sb.auth.onAuthStateChange((ev)=>{ if(ev==="SIGNED_OUT"){ unsubscribe?.(); unsubscribe=null; } });
boot();
