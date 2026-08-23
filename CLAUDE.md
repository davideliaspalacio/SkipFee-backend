@AGENTS.md

# backend-skipfee — API central del ecosistema

> Contexto del ecosistema completo: ver [`../CLAUDE.md`](../CLAUDE.md). Este doc es el detalle del backend.
>
> **Este es el cerebro de Skipfee.** Único repo que habla con Supabase, Kapso, Wompi, Gemini, Google Maps y Discord. Toda la lógica de negocio y los secretos viven aquí. Los 3 frontends solo consumen su REST API.

## Propósito

API + lógica de negocio para pedidos por WhatsApp: recibe mensajes (webhook Kapso), los procesa con un bot conversacional, gestiona el catálogo/pedidos/clientes, cobra con Wompi, y expone todo al panel admin y a la tienda. `name` en package.json: **`backend`**. Versión `0.1.0` (WIP).

## Stack

- **Next.js 16.2.6** (App Router, **API routes**, runtime **Node** — no Edge) + React 19 + TypeScript strict.
- **`@supabase/supabase-js` 2.x** — Postgres + Auth + Realtime + Storage.
- **`zod` 4** — validación de env, payloads y webhooks (no hay ORM; SQL crudo vía Supabase client).
- **`@kapso/whatsapp-cloud-api` 0.2.x** — WhatsApp.
- **`@google/genai` 2.x** — Gemini (fallback del bot).
- **Vitest** para tests; ESLint 9.
- Corre en `localhost:3000` (dev). Prod: `https://backend.skipfee.co`.

## Estructura

```
src/
  app/api/                      # Todos los endpoints REST (App Router route handlers)
    auth/{login,logout,me}/     # Supabase Auth → cookies httpOnly
    orders/                     # CRUD + [id]/status, [id]/cook, stats
    chats/                      # bandeja WA: [id]/messages, takeover, release, upload-image, stats
    products/  zones/  cooks/   # catálogo y config operativa
    promotions/                 # incl. /active (consumida por la tienda)
    checkout/                   # sessions, [orderId], [orderId]/cart, [orderId]/pay  (contrato tienda)
    webhooks/{kapso,wompi}/     # entrada de WhatsApp y confirmación de pago (firma + dedup)
    cron/{inactivity-check,expire-drafts,survey-dispatch}/   # llamados por pg_cron
    leads/                      # POST desde la landing → Supabase + Discord
    settings/ bot/messages/ dashboard/ reports/ customers/ rewards/ surveys/ quotes/ health/
  lib/
    db.ts                       # supabaseAdmin() [service_role] / supabasePublic()
    auth.ts  env.ts (zod)  serializers.ts (snake_case BD → camelCase API)
    pricing.ts  hours.ts  internal-origin.ts
    bot/                        # agent.ts, gemini*, prompt.ts, tools.ts, flow/ (state machine), messages/
    checkout/                   # totals.ts, promotions.ts, gift.ts, cors.ts, access.ts
    kapso/                      # client.ts (sendText/sendImage), verify.ts (HMAC), handlers/
    wompi/signature.ts          # firmas integrity + webhook
    geo/{google.ts,polygon.ts}  # geocoding + punto-en-polígono
    orders/{notify.ts,survey.ts,rewards.ts}
supabase/migrations/            # 0001 … 0036 (esquema versionado, SQL)
middleware.ts                   # CORS + gate de auth para rutas privadas
```

## API REST (endpoints principales)

- **Auth:** `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/signup` (registro público), `POST /api/auth/redeem` (canjea el pase de un solo uso del alta por una sesión), `forgot-password`, `reset-password`.
- **Pedidos:** `GET/POST /api/orders`, `GET /api/orders/:id`, `PATCH /api/orders/:id/status`, `PATCH /api/orders/:id/cook`, `GET /api/orders/stats`.
- **Chats (WA):** `GET /api/chats`, `GET /api/chats/:id/messages`, `POST /api/chats/:id/{takeover,release,messages,upload-image}`, `GET /api/chats/stats`.
- **Catálogo/config:** `products`, `zones`, `cooks`, `settings`, `bot/messages`, `promotions` (+ `/active`).
- **Checkout (tienda):** `sessions`, `:orderId`, `:orderId/cart` (PUT), `:orderId/pay` (POST). Contrato detallado en `CONTRACT_CHECKOUT.md` si existe + `../CLAUDE.md` §5.3.
- **Webhooks:** `POST /api/webhooks/kapso`, `POST /api/webhooks/wompi` (verifican firma HMAC; Kapso además deduplica por `webhook_events`).
- **Cron** (header `x-cron-secret`): `inactivity-check`, `expire-drafts`, `survey-dispatch`, `trials` (avisa de pruebas vencidas, diario 05:10 UTC — no suspende), `onboarding-nudge` (avisa por Discord de los negocios trabados: 48 h sin carta, 72 h sin WhatsApp).
- **Onboarding y arranque:** `GET /api/<code>/onboarding` (checklist calculado de datos reales), `POST /api/<code>/catalog/extract` (foto de la carta → borrador con Gemini) y `/catalog/import`.
- **Pagos por empresa:** `GET/PUT /api/<code>/payments` — modo `mock` (pasarela de prueba, default de toda empresa nueva) o `real` (Wompi con las llaves del comercio). No devuelve secretos; pasar a `real` sin las tres llaves da 400.
- **Plataforma (solo owner):** `GET/POST /api/platform/companies`, `GET/PATCH /api/platform/companies/:codeOrSlug` (activar/suspender, plan, extender o reiniciar la prueba), `GET/PATCH /api/platform/settings` (días de prueba y qué pasa al vencer).
- **Otros:** `leads`, `dashboard/today`, `reports/summary`, `customers`, `rewards/:id/{approve,reject}`, `surveys`, `quotes`, `health`.

**Prueba gratis (`lib/trial.ts`):** **7 días** (configurables en `platform_settings`), y el reloj arranca **al registrarse** (`arrancarTrial`, desde `provisionCompany`). `companies.plan` es `trial` | `activo` | `cortesia`; las empresas anteriores a la 0053 quedaron en `cortesia` (sin vencimiento).

Al vencer se cierra el **panel**, no la venta: el corte lo aplica `getTenantContext` con un 402, que es por donde pasan todas las rutas `/api/<code>/…` y ninguna pública — el webhook de WhatsApp, el checkout y el de Wompi no lo tocan, así que el bot sigue atendiendo y el comensal sigue pagando. `status = 'suspended'` es otra cosa: la palanca manual del owner, que sí apaga todo (403). El cron `trials` **no suspende**, solo avisa por Discord.

**Entrada sin fricción tras el alta:** el signup emite un `pase` —el `hashed_token` de un magiclink de Supabase, generado con `generateLink`, que **no envía correo**— y la landing redirige a `<panel>/entrar?t=…`. El panel lo canjea en `POST /api/auth/redeem` y entra directo a Primeros pasos. Se usa un pase y no los tokens porque lo que viaja por la URL queda en el historial: el pase **muere al primer uso** y expira solo. Sin tabla propia: el ciclo de vida lo maneja Supabase.

**Cifrado de credenciales (`lib/crypto.ts`):** las columnas secretas de `company_integrations` (API keys de Kapso y Evolution, secretos de Wompi) se guardan cifradas con AES-256-GCM y prefijo `enc:v1:`, con la clave en `CREDENTIALS_KEY`. `getCompanyIntegrations` descifra al leer, así que el resto del backend no se entera; los writes pasan por `cifrarPatch`. Un valor sin prefijo se devuelve tal cual (texto plano heredado), así que la migración es transparente. `scripts/secure-credentials.mjs` cifra lo que quede en claro y siembra Wompi desde el `.env`. ⚠️ Sin `CREDENTIALS_KEY` en producción, una credencial cifrada deja al negocio mudo: pon la clave **antes** de cifrar empresas vivas (`--excepto <code>`).

**Auth/seguridad:** `middleware.ts` aplica CORS y exige sesión (JWT en cookie `bs_session` o header `Authorization: Bearer`) salvo rutas públicas (`health`, `checkout/*`, `leads`, webhooks). Escrituras a BD con `service_role` (bypassa RLS). Rate-limit en `POST /api/orders` (10/h por teléfono → 429).

## Modelo de datos (Postgres / Supabase)

Esquema en `supabase/migrations/0001..0036`. RLS activado en todas las tablas: **lectura pública, escritura solo `service_role`**; excepciones privadas **`leads`** y **`webhook_events`** (sin política pública). Realtime publicado en `orders`, `chats`, `messages`.

**Enums:** `order_status` (`nuevo, pagado, cocina, empacado, ruta, entregado, borrador, expirado, pendiente_pago`), `chat_status` (`bot, human, pending`), `message_direction` (`in, out, bot`), `customer_tag` (`VIP, Recurrente, Nuevo`).

**Tablas:**
- **`orders`** — núcleo. `id`(uuid txt), `order_number`(bigint seq único `#1..`), `customer_id`, `total`/`tip`/`discount`(int COP), `zone_id`, `status`, `address`/`phone`/`lat`/`lng`, `payment_method`, `note`, `cook_id`, `promo_id`, `wompi_tx_id`(único), `notified_statuses`(txt[] idempotencia notif.), `expires_at`(borrador), `delivered_at`, `created_at/updated_at`. Muchos campos nullable desde mig. 0008 (para borradores). Índices por status, zone, customer, cook activo, expires_at, wompi_tx_id, created_at desc.
- **`order_items`** — `order_id`(cascade), `product_id`, `qty`, `price_at_order`(snapshot del precio).
- **`customers`** — `phone` **único** (E.164), `name`, `addr`, `zone_id`, `email`, `lat/lng`, contadores `pedidos/ticket/ultimo/rating`, `tag`.
- **`products`** — `name`, `price`(int COP), `cat`, `available`, `img`, `description`, `sold`, `archived`.
- **`zones`** — `name`, `tarifa`(int COP), `color`, `lat/lng`, `coverage`(jsonb polígono), `coverage_radius_m`(fallback círculo), `archived`.
- **`chats`** — `id`=`wa:<phone>`, `customer_id`, `status`(bot/human/pending), `flow_state`(jsonb máquina de estados del bot), `flow_updated_at`, `last/time/unread`, `last_message_at`. Realtime.
- **`messages`** — `chat_id`(cascade), `direction`, `body`, `media_url`, `kapso_message_id`(único, dedup), `created_at/delivered_at/read_at`. Realtime.
- **`settings`** — **una fila por empresa**. Horarios (`hours` jsonb por día, `open/close_hour`, `open_days`), `base_delivery_fee`, `orders_paused`, `reminder_minutes`, ventana de entregados, config post-venta (`postventa_enabled`, `survey_delay_minutes`, `survey_min_days`, `review_gift_product_id`), `review_categories`(jsonb). Identidad del negocio: `business_description` (la usa el prompt del bot), `logo_url` y `brand_color` (hex con CHECK — se inyecta en el CSS de la tienda).
- **`cooks`** — `name`, `hours`(jsonb semanal), `archived`.
- **`promotions`** — `kind`(`product|weekday`), `discount_type`(`percent|fixed|free_item|two_for_one`), `discount_value`, `min_subtotal`, `config`(jsonb: product_ids/weekdays/horas), `active`, `starts_at/ends_at`.
- **`order_surveys`** — `order_id`(único), `phone`, `rating`(1-5), `comment`, `sent_at/responded_at`.
- **`rewards`** — cupones post-reseña: `phone`, `kind`, `status`(`pendiente|otorgado|canjeado|expirado|rechazado`), `order_id_origen`, `screenshot_url`, `granted_by/granted_at`, `redeemed_*`, `expires_at`.
- **`leads`** — pre-registro landing (privada): `business_name`, `contact_name`, `whatsapp`, `email`, `city`, `orders_volume`, `est_loss`, `cuisine_type`, `current_apps`, `estado`, `source`.
- **`bot_messages`** — textos del bot editables desde el panel: `key`(PK), `content`(jsonb), `enabled`. Interpolación `{{var}}`.
- **`webhook_events`** — dedup de Kapso por `idempotency_key`.
- **`companies`** — tenants. Además de `code`/`slug`/`name`/`status`: **`plan`** (`trial|activo|cortesia`), **`trial_started_at`**, **`trial_ends_at`** (mig. 0053). Desde la 0052 todas las FK que la apuntan son `ON DELETE CASCADE`: borrar una empresa borra TODO lo suyo.
  Además `onboarding_nudges` (txt[]): qué avisos del carril humano ya salieron (mig. 0055).
- **`platform_settings`** — **fila única `id=1`**, sin lectura pública (solo `service_role`): `trial_days` (días de prueba de las altas nuevas) y `al_vencer` (`bloquear|avisar`).

**Triggers/funciones (PL/pgSQL):**
- **`assign_cook_on_paid`** (mig. 0020) — al entrar a `pagado` y sin cocinero, elige el cocinero **en turno** (según `cooks.hours`, zona horaria America/Bogota; `hours` null = disponible siempre) con **menor carga activa** (pedidos en `pagado`/`cocina`), desempate por antigüedad. Si nadie disponible → `cook_id` null.
- **`set_updated_at`** — toca `updated_at` en cada UPDATE.
- Secuencia `orders_order_number_seq` para `order_number`.

**Extensiones:** `pg_cron` + `pg_net` (crons que llaman al backend; requieren `app.backend_url` y `app.cron_secret` configurados como GUC en Supabase).

## El bot de WhatsApp

`lib/bot/`. Máquina de estados persistida en `chats.flow_state` (jsonb): pasos `menu → registro_nombre → registro_email → direccion → zona → … → link_enviado`. NLU básico por intents (`flow/intent.ts`); si no entiende, **fallback a Gemini 2.5** (`bot/gemini*.ts`). Mensajes salientes renderizados con interpolación `{{var}}` desde `bot_messages` (editables) con defaults en `bot/messages/defaults.ts`. Nudge por inactividad vía cron.

## Puerto de WhatsApp (`lib/whatsapp/`)

Una empresa habla por **Kapso** (Cloud API oficial de Meta, requiere número verificado) o por **Evolution API** (self-hosted, conexión por QR, para negocios que no pasan la verificación). La elección vive en `company_integrations.whatsapp_provider` — **una empresa, un proveedor**.

```
lib/whatsapp/
  types.ts          contrato interno (SendResult, InboundEnvelope, capabilities)
  provider.ts       la interfaz + SessionCapableProvider
  factory.ts        providerFor(companyId) → el adaptador correcto
  degrade.ts        botones/listas → texto numerado, y el mapeo de vuelta
  pending.ts        persistencia de chats.pending_options
  inbound.ts        manejo compartido de entrantes (agnóstico de proveedor)
  kapso/            adaptador oficial
  evolution/        adaptador no oficial (client HTTP + parse + adapter)
```

**Regla dura:** nadie fuera de `lib/whatsapp/` importa `@/lib/kapso/*` ni el cliente de Evolution. Todo envío sale por `lib/bot/sender.ts` → `providerFor(companyId)`. Saltarse esto rompe a las empresas del otro proveedor.

### La degradación es un PAR

Evolution no soporta botones/listas de forma confiable, así que su adaptador los renderiza como menú numerado (`1️⃣ Hacer pedido`). Eso obliga a la mitad de vuelta: cuando el cliente responde `"2"`, hay que reconvertirlo al id original (`btn_humano`) **antes** de que llegue al state machine, o el bot se queda mudo a mitad del pedido.

Las opciones ofrecidas se guardan en **`chats.pending_options`** (jsonb), **no** en `flow_state`: `processFlowMessage` hace loadFlowState → routeFlow → saveFlowState y los envíos ocurren dentro de routeFlow, así que cualquier cosa escrita en flow_state sería pisada. Se consumen una sola vez y vencen a los 30 min.

### Endpoints

- `POST /api/webhooks/evolution/:companySlug` — espejo del de Kapso. Autenticación por **token compartido** (Evolution no firma con HMAC), dedup por `key.id`, y maneja `connection.update`.
- `GET|PUT /api/:companyId/whatsapp/provider` — ver/cambiar proveedor y credenciales. Valida que existan credenciales **antes** de conmutar. Nunca devuelve secretos.
- `GET|POST|DELETE /api/:companyId/whatsapp/session` — estado, QR y logout. **409 en Kapso**: no tiene sesión.

### Empresa de pruebas

`supabase/seed_testing_company.sql` crea la empresa `testing` para correr el mismo flujo por ambos proveedores y comparar (sobre todo la degradación). Se conmuta por el endpoint, no editando la tabla.

### Riesgo asumido

Evolution corre sobre el protocolo **no oficial** de WhatsApp. Meta no lo permite: **riesgo real de baneo del número del negocio**. Es la opción de entrada, no la recomendada. Además la sesión vive en el servidor: si se cae, alguien re-escanea el QR.

## Integraciones (detalle)

- **WhatsApp (multi-proveedor):** ver §"Puerto de WhatsApp" abajo. Kapso (oficial) y Evolution (no oficial) detrás de la misma interfaz.
- **Wompi:** modo `mock` (default) o `real` (`WOMPI_MODE`). Firma **integrity** antes de pagar y verifica firma del **webhook** (`lib/wompi/signature.ts`). `wompi_tx_id` único evita doble procesamiento.
- **Gemini:** `GEMINI_MODEL` (default `gemini-2.5-flash`).
- **Google Maps:** geocoding + `geo/polygon.ts` para resolver zona por lat/lng (polígono o radio fallback). Si falta `GOOGLE_MAPS_API_KEY`, cae a selección manual.
- **Discord:** webhook de aviso de leads (opcional).

## Variables de entorno

`.env.local` (git-ignored), validadas con zod en `lib/env.ts` (faltante requerida = el server no arranca). Requeridas: `KAPSO_API_KEY`, `KAPSO_WEBHOOK_SECRET`, `KAPSO_PHONE_NUMBER_ID`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`. Opcionales: `GEMINI_MODEL`, `WOMPI_*` (MODE/API_BASE/PUBLIC_KEY/INTEGRITY_SECRET/EVENTS_SECRET), `GOOGLE_MAPS_API_KEY`, `DISCORD_WEBHOOK_URL`, `CREDENTIALS_KEY` (cifrado de credenciales; **obligatoria en producción**), `STOREFRONT_ORIGIN`, `EXTRA_CORS_ORIGINS`, `CHECKOUT_TTL_MINUTES`, `CRON_SECRET`, `NEXT_PUBLIC_APP_ORIGIN`.

## Build / test

`npm run dev` (:3000, Turbopack) · `npm run build` · `npm start` · `npm run lint` · `npm run test` (Vitest). Tests unitarios en `src/**/*.test.ts` (totals, firmas, etc.). `next.config.ts` incluye `allowedDevOrigins` para túneles ngrok.

## Estado y gotchas

- **WIP** v0.1.0. Roadmap en `PLAN.md`. Completos: pedidos, bot, checkout Wompi, asignación de cocinero, promociones, post-venta, leads.
- **Crons en local:** Supabase gestionado no alcanza `localhost`; usa **ngrok** (y `allowedDevOrigins`) o desactívalos en dev.
- **Wompi `real`** aún no probado a fondo en prod.
- **Multi-empresa en curso:** rutas `/api/[companyId]/*`, `company_integrations` y RLS por tenant ya existen. Quedan callers legacy que caen al env global cuando no reciben `companyId` (ver `lib/bot/sender.ts`).
- **El bot se despacha fire-and-forget** (`void processFlowMessage`) desde `lib/whatsapp/inbound.ts`: un reinicio del proceso **pierde los mensajes en vuelo**, sin reintento ni backpressure. Deuda conocida; la solución es una cola (pgmq).
- **Botones por Evolution:** no llegan como botones, llegan degradados a texto. Cualquier handler nuevo que use `botSendButtonsMsg` hereda la degradación gratis — pero si lees `buttonReplyId` a mano en otro sitio, acuérdate del par.
- **Migraciones:** el esquema se versiona en `supabase/migrations/`. Cambios de BD = nueva migración numerada, no edites las viejas. Hay un proyecto Supabase por MCP (`mcp__supabase__*`): usa `list_tables`/`list_migrations` para ver el estado real antes de tocar.
- **Serialización:** la BD usa snake_case; la API responde camelCase (`lib/serializers.ts`). Respeta esa frontera.
