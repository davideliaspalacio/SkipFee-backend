-- Bucket para fotos de productos del catálogo.
--
-- Antes: products.img guardaba URLs externas (loremflickr en el seed). Ahora
-- el admin sube fotos desde el panel y se almacenan en Supabase Storage.
-- products.img sigue siendo `text` y acepta ambas formas (URL externa o del
-- bucket público), así que las imágenes del seed no se rompen.
--
-- Bucket público para que el storefront cargue las fotos directo sin signed
-- URLs (las fotos de comida no son sensibles).
--
-- Escritura: solo `service_role` (el backend usa supabaseAdmin con service_role
-- key). El bucket no tiene policy de INSERT/UPDATE/DELETE para roles `anon` ni
-- `authenticated`, así que solo nuestros endpoints pueden mutar.

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

-- Lectura pública (sin signed URL): cualquiera con la URL ve la foto.
drop policy if exists "Public read product-images" on storage.objects;
create policy "Public read product-images"
  on storage.objects for select
  using (bucket_id = 'product-images');
