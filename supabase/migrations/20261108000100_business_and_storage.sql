-- Mon Colis Mali: fonctions métier (devis, validation, étapes, arrivages) et stockage.

create or replace function public.send_quote(p_order bigint, p_lines jsonb, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  if not public.is_admin() then raise exception 'Réservé au gérant'; end if;
  select * into o from public.orders where id = p_order for update;
  if o.id is null then raise exception 'Commande introuvable'; end if;
  if o.status not in ('demande','devis') then raise exception 'Le devis ne peut plus être modifié'; end if;
  if jsonb_array_length(coalesce(p_lines,'[]')) = 0 then raise exception 'Le devis est vide'; end if;
  delete from public.quote_lines where order_id = p_order;
  insert into public.quote_lines (order_id, position, label, amount)
    select p_order, (x.ord - 1)::smallint, x.v->>'label', (x.v->>'amount')::numeric
    from jsonb_array_elements(p_lines) with ordinality as x(v, ord);
  update public.orders set status = 'devis', quote_note = nullif(trim(p_note),''), quote_sent_at = now() where id = p_order;
  insert into public.notifications (user_id, order_id, kind, body)
    values (o.client_id, p_order, 'devis', 'Votre devis pour ' || o.ref || ' est prêt.');
end $$;

create or replace function public.respond_quote(p_order bigint, p_accept boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders; num text;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null or o.client_id <> auth.uid() then raise exception 'Commande introuvable'; end if;
  if o.status <> 'devis' then raise exception 'Ce devis n''attend pas de réponse'; end if;
  if p_accept then
    num := public.next_invoice_number('FAC');
    update public.orders set status = 'valide', stage = 0, invoice_number = num, invoice_date = now() where id = p_order;
    insert into public.tracking_events (order_id, stage) values (p_order, 0);
    insert into public.notifications (user_id, order_id, kind, body)
      values (o.client_id, p_order, 'facture', 'Commande ' || o.ref || ' validée. Votre facture ' || num || ' est prête.');
  else
    update public.orders set status = 'refuse' where id = p_order;
  end if;
end $$;

create or replace function public.set_stage(p_order bigint, p_stage smallint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Réservé au gérant'; end if;
  update public.orders set stage = greatest(stage, p_stage) where id = p_order and status = 'valide';
  insert into public.tracking_events (order_id, stage) values (p_order, p_stage) on conflict do nothing;
end $$;

create or replace function public.lot_depart(p_lot bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Réservé au gérant'; end if;
  update public.lots set status = 'transit', departed_at = now() where id = p_lot and status = 'chargement';
  if not found then raise exception 'Arrivage déjà parti'; end if;
  update public.orders set stage = greatest(stage, 2) where lot_id = p_lot;
  insert into public.tracking_events (order_id, stage) select id, 2 from public.orders where lot_id = p_lot on conflict do nothing;
end $$;

create or replace function public.lot_arrive(p_lot bigint, p_weights jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare r record; num text;
begin
  if not public.is_admin() then raise exception 'Réservé au gérant'; end if;
  update public.lots set status = 'arrive', arrived_at = now() where id = p_lot and status = 'transit';
  if not found then raise exception 'Cet arrivage n''est pas en route'; end if;
  for r in select * from public.orders where lot_id = p_lot loop
    if (p_weights ->> r.id::text) is null then raise exception 'Poids manquant pour %', r.ref; end if;
    num := coalesce(r.final_invoice_number, public.next_invoice_number('FAR'));
    update public.orders set weight_kg = (p_weights ->> r.id::text)::numeric, stage = greatest(stage, 3),
      final_invoice_number = num, final_invoice_date = coalesce(final_invoice_date, now()) where id = r.id;
    insert into public.tracking_events (order_id, stage) values (r.id, 2), (r.id, 3) on conflict do nothing;
    insert into public.notifications (user_id, order_id, kind, body)
      values (r.client_id, r.id, 'arrivee', 'Votre colis ' || r.ref || ' est arrivé à Bamako (' || replace((p_weights ->> r.id::text), '.', ',') || ' kg). Votre facture est prête.');
  end loop;
end $$;

revoke execute on function public.send_quote(bigint,jsonb,text), public.respond_quote(bigint,boolean),
  public.set_stage(bigint,smallint), public.lot_depart(bigint), public.lot_arrive(bigint,jsonb) from public, anon;
grant execute on function public.send_quote(bigint,jsonb,text), public.respond_quote(bigint,boolean),
  public.set_stage(bigint,smallint), public.lot_depart(bigint), public.lot_arrive(bigint,jsonb) to authenticated;

-- Storage: photos privées (dossier = id du client), logo public
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg','image/png','image/webp']),
       ('brand', 'brand', true, 2097152, array['image/jpeg','image/png','image/webp','image/svg+xml']);

create policy "photos: upload in own folder or admin" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.is_admin())));
create policy "photos: read own or admin" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.is_admin())));
create policy "brand: admin upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'brand' and (select public.is_admin()));
create policy "brand: admin update" on storage.objects for update to authenticated
  using (bucket_id = 'brand' and (select public.is_admin()));
