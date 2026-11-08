-- Mon Colis Mali: schéma initial (tables, RLS, fonctions métier, stockage).
-- Appliqué sur le projet Supabase « mon-colis-mali ».

-- ========== TABLES ==========
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text not null unique,
  city text,
  role text not null default 'client' check (role in ('client','admin')),
  created_at timestamptz not null default now()
);

create table public.settings (
  id int primary key default 1 check (id = 1),
  name text not null default 'Mon Colis Mali',
  slogan text not null default 'On commande pour les gens partout en Afrique',
  phone text not null default '',
  address text not null default '',
  color text not null default '#14297a',
  accent text not null default '#f39314',
  logo_url text,
  rates jsonb not null default '{"Chine":9000,"Lomé (Togo)":1500,"Burkina Faso":1000,"Niger":1200,"Sénégal":1500}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1);

create table public.lots (
  id bigint generated always as identity primary key,
  ref text generated always as ('LOT-' || lpad(id::text, 3, '0')) stored,
  origin text not null,
  mode text not null check (mode in ('Aérien','Maritime','Route')),
  rate numeric(12,0) not null default 0 check (rate >= 0),
  status text not null default 'chargement' check (status in ('chargement','transit','arrive')),
  created_at timestamptz not null default now(),
  departed_at timestamptz,
  arrived_at timestamptz
);

create table public.orders (
  id bigint generated always as identity primary key,
  ref text generated always as ('CMD-' || lpad(id::text, 4, '0')) stored,
  client_id uuid not null references public.profiles(id) on delete cascade,
  origin text not null check (origin in ('Chine','Lomé (Togo)','Burkina Faso','Niger','Sénégal')),
  status text not null default 'demande' check (status in ('demande','devis','valide','refuse')),
  stage smallint not null default -1 check (stage between -1 and 4),
  lot_id bigint references public.lots(id) on delete set null,
  weight_kg numeric(8,2) check (weight_kg is null or weight_kg >= 0),
  quote_note text,
  quote_sent_at timestamptz,
  invoice_number text unique,
  invoice_date timestamptz,
  final_invoice_number text unique,
  final_invoice_date timestamptz,
  created_at timestamptz not null default now()
);
create index on public.orders (client_id);
create index on public.orders (lot_id);
create index on public.orders (status);

create table public.order_items (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.orders(id) on delete cascade,
  position smallint not null default 0,
  description text not null check (length(description) between 1 and 500),
  qty int not null default 1 check (qty between 1 and 100000),
  link text check (link is null or length(link) <= 1000),
  photo_path text
);
create index on public.order_items (order_id);

create table public.quote_lines (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.orders(id) on delete cascade,
  position smallint not null default 0,
  label text not null,
  amount numeric(12,0) not null check (amount >= 0)
);
create index on public.quote_lines (order_id);

create table public.tracking_events (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.orders(id) on delete cascade,
  stage smallint not null check (stage between 0 and 4),
  created_at timestamptz not null default now(),
  unique (order_id, stage)
);

create table public.payments (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.orders(id) on delete cascade,
  amount numeric(12,0) not null check (amount > 0),
  method text not null check (method in ('orange_money','wave','especes')),
  reference text,
  paid_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);
create index on public.payments (order_id);

create table public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  order_id bigint references public.orders(id) on delete cascade,
  kind text not null check (kind in ('devis','facture','arrivee','info')),
  body text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index on public.notifications (user_id, created_at desc);

create sequence public.invoice_seq;
create sequence public.invoice_far_seq;

-- ========== HELPERS ==========
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;
revoke execute on function public.is_admin() from public, anon;

create or replace function public.next_invoice_number(prefix text) returns text
language sql volatile security definer set search_path = '' as $$
  select prefix || '-' || extract(year from now())::int || '-' ||
    lpad((case when prefix = 'FAR' then nextval('public.invoice_far_seq') else nextval('public.invoice_seq') end)::text, 4, '0');
$$;
revoke execute on function public.next_invoice_number(text) from public, anon, authenticated;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, phone, city)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'full_name', 'Client'),
          coalesce(new.raw_user_meta_data->>'phone', new.id::text),
          new.raw_user_meta_data->>'city');
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ========== RLS ==========
alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.lots enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.quote_lines enable row level security;
alter table public.tracking_events enable row level security;
alter table public.payments enable row level security;
alter table public.notifications enable row level security;

create policy "profile: self or admin read" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));
create policy "profile: self update" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "profile: admin update" on public.profiles for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
revoke update on public.profiles from authenticated;
grant update (full_name, city) on public.profiles to authenticated;

create policy "settings: read" on public.settings for select to anon, authenticated using (true);
create policy "settings: admin write" on public.settings for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "orders: own or admin read" on public.orders for select to authenticated
  using (client_id = (select auth.uid()) or (select public.is_admin()));
create policy "orders: client creates request" on public.orders for insert to authenticated
  with check ((client_id = (select auth.uid()) and status = 'demande' and stage = -1 and lot_id is null
               and invoice_number is null and final_invoice_number is null and weight_kg is null)
              or (select public.is_admin()));
create policy "orders: admin update" on public.orders for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "orders: admin delete" on public.orders for delete to authenticated
  using ((select public.is_admin()));

create policy "items: read" on public.order_items for select to authenticated
  using ((select public.is_admin()) or exists (select 1 from public.orders o where o.id = order_id and o.client_id = (select auth.uid())));
create policy "items: add to own pending request" on public.order_items for insert to authenticated
  with check ((select public.is_admin()) or exists (select 1 from public.orders o where o.id = order_id and o.client_id = (select auth.uid()) and o.status = 'demande'));
create policy "items: admin update" on public.order_items for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "items: admin delete" on public.order_items for delete to authenticated
  using ((select public.is_admin()));

create policy "lines: read" on public.quote_lines for select to authenticated
  using ((select public.is_admin()) or exists (select 1 from public.orders o where o.id = order_id and o.client_id = (select auth.uid())));
create policy "lines: admin write" on public.quote_lines for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "events: read" on public.tracking_events for select to authenticated
  using ((select public.is_admin()) or exists (select 1 from public.orders o where o.id = order_id and o.client_id = (select auth.uid())));
create policy "events: admin write" on public.tracking_events for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "payments: read" on public.payments for select to authenticated
  using ((select public.is_admin()) or exists (select 1 from public.orders o where o.id = order_id and o.client_id = (select auth.uid())));
create policy "payments: admin write" on public.payments for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "lots: read" on public.lots for select to authenticated
  using ((select public.is_admin()) or exists (select 1 from public.orders o where o.lot_id = lots.id and o.client_id = (select auth.uid())));
create policy "lots: admin write" on public.lots for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "notif: own or admin read" on public.notifications for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy "notif: mark own read" on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "notif: admin insert" on public.notifications for insert to authenticated
  with check ((select public.is_admin()));
revoke update on public.notifications from authenticated;
grant update (read) on public.notifications to authenticated;

alter publication supabase_realtime add table public.orders, public.notifications, public.tracking_events, public.lots, public.payments;
