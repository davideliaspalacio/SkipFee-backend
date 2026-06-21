# Fase 1 multi-empresa — estado

> Plan completo: [`../PLAN_MULTI_EMPRESA.md`](../PLAN_MULTI_EMPRESA.md)

## Estado: código de Fase 1 COMPLETO

- Backend: `npx tsc --noEmit` limpio · `npx vitest run` → **297/297 tests** OK.
- Admin (`skipfee-admin`): `npx tsc --noEmit` limpio · `next build` (export) OK.
- **Sin aplicar a BD viva** (ver aviso). No probado end-to-end contra Postgres.

## ⚠️ Antes de aplicar / verificar

- El proyecto Supabase del MCP (`mvhhttydrcxjadaqokme`, "dev-derbiplay") **NO es la BD
  de SkipFee**. Las migraciones 0037–0039 están escritas pero **no aplicadas**.
  Aplicarlas en el proyecto Supabase correcto de SkipFee (`supabase db push` o MCP
  apuntando al proyecto correcto) y verificar.
- Las nuevas rutas/handlers asumen que 0037–0039 ya están aplicadas (columnas
  `company_id`, tablas de tenancy, RLS, numeración por empresa).

## ✅ Hecho

**Migraciones** (`supabase/migrations/`)
- `0037_companies_foundation.sql` — `companies`, `company_integrations`,
  `company_members`, `platform_admins` + helpers RLS `is_company_member()`,
  `is_platform_admin()`.
- `0038_add_company_id.sql` — `company_id NOT NULL` en 13 tablas + `settings`;
  uniques globales → por empresa; empresa por defecto para el seed.
- `0039_tenant_policies_and_numbering.sql` — policies `tenant_all` de pertenencia
  (reemplazan "public read"); numeración de pedidos por empresa; cocinero por empresa.

**Backend — fundación**
- `lib/db.ts` → `supabaseForUser(token)` (cliente RLS con JWT del usuario).
- `lib/tenant.ts` → `getTenantContext`, `withTenant`, `requirePlatformAdmin`.
- `lib/integrations.ts` → `getCompanyIntegrations`, `resolveCompanyByKapsoPhone`,
  `kapsoFor`, `kapsoCredentialsFor`, `wompiConfigFor`, `invalidateIntegrationsCache`.
- `lib/messaging.ts` → `recordMessage({...,companyId})` + `chatIdFor` (`wa:<companyId>:<phone>`).
- `lib/env.ts` → Kapso/Wompi dejan de ser requeridas (viven por empresa en BD).

**Backend — rutas** (todas las de negocio bajo `/api/[companyId]/` con `withTenant`,
`ctx.db`, scope `company_id`):
- orders (route/[id]/status/cook/stats), chats (+stats/messages/takeover/release/upload-image),
  products (+[id]/image), zones, cooks, promotions (+active), customers, dashboard/today,
  reports/summary, settings, bot/messages (+[key]), rewards (+approve/reject), surveys,
  quotes, messages/send.
- **Público/sistema:** `webhooks/kapso/[companyId]` y `webhooks/wompi/[companyId]`
  (firma con secret de la empresa), `checkout/*` (empresa resuelta por el pedido +
  Wompi por empresa), `products/available?company=<slug>`, `cron/*` (iteran por empresa),
  `auth/me` (contrato memberships), **NUEVO `platform/companies`** (owner: crear/listar
  empresas + super_admin + integraciones + settings).
- Bot (`lib/bot/**`): `companyId` propagado, `chats.id` por empresa, catálogo de mensajes
  y creación de pedidos (`lib/bot/orders.ts`) por empresa, envío vía `kapsoFor`.
- `middleware.ts` + `lib/checkout/access.ts`: allowlists actualizadas al árbol `[companyId]`.

**Admin (`skipfee-admin`)**
- `lib/api/activeCompany.ts` (store empresa activa) + `lib/queries/company.ts`
  (`useActiveCompany`, `setActiveCompany`).
- `lib/api/client.ts` → `tenantRequest`/`tenantMultipart` (prefijo `/api/<slug>`).
- Todos los `lib/api/*` de negocio migrados; `auth.me()` consume el contrato e hidrata el store.
- `lib/queries/keys.ts` con `companySlug` en las keys; queries de negocio gateadas con `enabled`.
- `lib/roles.ts` → rol `super_admin`.

## ⏳ Pendiente (verificación y remates)

1. **Aplicar migraciones 0037–0039** en el proyecto Supabase correcto y probar end-to-end.
2. **Seam bot → checkout/sessions:** el bot manda `companyId` (uuid) en el payload, pero
   `checkout/sessions` espera `company` (slug). Alinear (uuid vs slug) y probar el flujo del bot.
3. **`lib/hours.ts loadOpenState`** aún lee `settings` por `id=1` en una ruta del bot
   (TODO marcado). Pasar `companyId`.
4. ~~Pantalla "Empresas" (owner) en el admin~~ ✅ HECHO: `app/(admin)/empresas`,
   `components/features/empresas/`, `lib/api/platform.ts`, `lib/queries/platform.ts`,
   + selector de empresa activa en la topbar (`AdminShell`). Falta probarla contra BD viva.
5. **Cifrar** las credenciales de `company_integrations` (Vault/pgsodium) — hoy texto plano.
6. **Endurecer:** varios helpers tienen `companyId` opcional (retrocompat de la migración):
   `recordMessage`, `redeemRewardForOrder`, `notifyOrderStatus`, `sendDeliverySurvey`,
   gift/hours. Una vez todo verificado, volverlos requeridos para cerrar el fallback legacy.
7. **Onboarding Kapso/Wompi por empresa:** conectar el número de cada empresa en Kapso y
   apuntar su webhook a `/api/webhooks/kapso/<slug>` (y Wompi a `/api/webhooks/wompi/<slug>`).
8. Limpiar entrada muerta `'/api/wompi/webhook'` en `lib/checkout/access.ts` (inocua).
