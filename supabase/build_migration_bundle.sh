#!/usr/bin/env bash
# Regenera migrate_0036_to_0047.sql a partir de las migraciones sueltas.
# Correr desde backend-skipfee/supabase/ tras tocar cualquier 00XX_*.sql.
set -euo pipefail
cd "$(dirname "$0")"
OUT=migrate_0036_to_0047.sql

BLOQUE1=(0036_leads 0037_companies_foundation 0038_add_company_id
         0039_tenant_policies_and_numbering 0040_company_code 0041_chat_unread_trigger
         0042_chat_phone_lookup_idx 0043_marketplace_channels
         0044_assign_order_number_security_definer 0045_order_status_dinein_values)
BLOQUE2=(0046_dinein_foundations 0047_whatsapp_provider)

emit() {
  for n in "$@"; do
    printf '\n-- =========================================================================\n'
    printf -- '-- >>> %s.sql\n' "$n"
    printf -- '-- =========================================================================\n'
    cat "migrations/$n.sql"; printf '\n'
  done
}

{
cat <<'HDR'
-- =========================================================================
-- SkipFee · Bundle de migraciones 0036 → 0047  (+ empresa de pruebas)
-- =========================================================================
-- Generado por build_migration_bundle.sh — no editar a mano.
--
-- Lleva una BD que está en la migración 0035 (single-tenant) al estado que el
-- backend actual necesita: multi-empresa, canales de venta, dine-in y el puerto
-- multi-proveedor de WhatsApp (Kapso | Evolution).
--
-- CÓMO CORRERLO
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrate_0036_to_0047.sql
--   (o pegarlo completo en el SQL Editor de Supabase)
--
-- ⚠️ DOS TRANSACCIONES, NO UNA
--   La 0045 agrega valores al enum `order_status` y la 0046 los USA. PostgreSQL
--   no permite usar un valor de enum nuevo dentro de la misma transacción que lo
--   creó ("unsafe use of new value"), así que hay un COMMIT obligatorio en medio:
--       Bloque 1: 0036 → 0045   (multi-empresa, canales, valores del enum)
--       Bloque 2: 0046 → 0047   (tablas dine-in, proveedor WhatsApp, seed)
--   Son dos bloques atómicos. Si el 2 falla, el 1 ya quedó aplicado; como todo
--   es reaplicable, se corrige y se vuelve a correr el archivo entero.
--
-- ⚠️ NO DEJES EL BLOQUE 2 A MEDIAS
--   `getCompanyIntegrations` hace SELECT de las columnas de la 0047. Con la 0046
--   aplicada y la 0047 no, se rompe el envío de WhatsApp de TODAS las empresas,
--   también las que usan Kapso.
--
-- QUÉ LE PASA A TUS DATOS
--   La 0038 crea la empresa 'bros-and-subs' (uuid 000…001) y le reasigna TODO lo
--   existente (orders, chats, products, settings, …). Nada se pierde ni se
--   duplica: tu operación actual pasa a ser esa empresa.
--
-- REAPLICABLE: correrlo dos veces no rompe nada ni duplica datos.
-- =========================================================================


-- #########################################################################
-- BLOQUE 1 — 0036 → 0045
-- #########################################################################
BEGIN;
HDR
emit "${BLOQUE1[@]}"
cat <<'MID'

COMMIT;


-- #########################################################################
-- BLOQUE 2 — 0046 → 0047 + empresa de pruebas
-- (aparte porque usa los valores de enum que agregó la 0045)
-- #########################################################################
BEGIN;
MID
emit "${BLOQUE2[@]}"
printf '\n-- =========================================================================\n'
printf -- '-- >>> Empresa de PRUEBAS (slug: testing)\n'
printf -- '-- =========================================================================\n'
cat seed_testing_company.sql
cat <<'END'

COMMIT;

-- =========================================================================
-- Refrescar la cache de esquema de PostgREST. Sin esto la API sigue
-- respondiendo "Could not find the table ... in the schema cache" un rato
-- aunque las tablas ya existan.
-- =========================================================================
NOTIFY pgrst, 'reload schema';
END
} > "$OUT"

# -------------------------------------------------------------------------
# Lint: atrapa guardas mal formadas antes de que lleguen a Supabase.
#
# Postgres LOCAL trata `DROP ... IF EXISTS ... ON <tabla-inexistente>` como
# NOTICE y sigue; Supabase lo devuelve como ERROR 42P01. Por eso una corrida
# local en verde NO garantiza que el bundle corra en Supabase, y hace falta
# revisar el texto explícitamente.
# -------------------------------------------------------------------------
errores=0
if grep -nE "^(DROP (TRIGGER|POLICY)) IF EXISTS [A-Za-z0-9_]+ ON (public|auth);" "$OUT"; then
  echo "ERROR: guarda sin nombre de tabla (quedó solo el esquema)." >&2; errores=1
fi
if grep -nE "ON [A-Za-z0-9_]+\.\s*;" "$OUT"; then
  echo "ERROR: referencia a tabla truncada." >&2; errores=1
fi
# Todo DROP TRIGGER/POLICY debe apuntar a una tabla real del proyecto.
if grep -oE "^DROP (TRIGGER|POLICY) IF EXISTS [A-Za-z0-9_]+ ON [A-Za-z0-9_.]+" "$OUT" \
   | awk '{print $NF}' | grep -qxE "public|auth"; then
  echo "ERROR: DROP apuntando a un esquema en vez de a una tabla." >&2; errores=1
fi
[ "$errores" -eq 0 ] || { echo "Bundle NO generado por errores de lint." >&2; rm -f "$OUT"; exit 1; }

echo "generado $OUT ($(wc -l < "$OUT") líneas)"
