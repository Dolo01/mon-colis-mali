# Mon Colis Mali

Application (PWA) pour commander des articles en Chine, à Lomé, au Burkina, au Niger et au Sénégal et les faire livrer au Mali :
demande avec photos → devis → facture → suivi du colis → arrivée au Mali avec facture d'arrivée au poids.

## Stack
- Vite + JavaScript, installable en PWA (`vite-plugin-pwa`)
- Supabase : base Postgres avec Row Level Security, Auth, Storage (photos privées, logo public), Realtime, Edge Function `signup`

## Démarrer
```bash
npm install
npm run dev
```
Variables facultatives (sinon les valeurs du projet sont utilisées) : `VITE_SUPABASE_URL`, `VITE_SUPABASE_KEY` (clé publishable).

## Comptes
- Les clients s'inscrivent avec numéro WhatsApp + mot de passe (fonction `supabase/functions/signup`, sans SMS).
- Le gérant est un compte avec `profiles.role = 'admin'` (à donner via SQL).

## Organisation
- `src/api.js` : tout l'accès aux données (lecture, écritures, temps réel)
- `src/main.js` : interface (vues client et gérant, devis/factures en image et PDF)
- `src/styles.css` : design
- `supabase/functions/signup` : création de compte
