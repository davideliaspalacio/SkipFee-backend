-- Bucket para archivos enviados desde el panel de WhatsApp (por ahora solo
-- imágenes). La URL pública resultante se pasa a Kapso (sendImage usa `link`)
-- y se persiste en messages.media_url.
--
-- Bucket público porque Kapso/WhatsApp Cloud necesita poder descargar el
-- archivo desde una URL accesible sin auth.
--
-- Escritura: solo `service_role` (los endpoints del backend usan supabaseAdmin
-- con service_role key). No hay policy de INSERT para anon/authenticated.

insert into storage.buckets (id, name, public)
values ('chat-media', 'chat-media', true)
on conflict (id) do nothing;

-- Lectura pública (sin signed URL).
drop policy if exists "Public read chat-media" on storage.objects;
create policy "Public read chat-media"
  on storage.objects for select
  using (bucket_id = 'chat-media');
