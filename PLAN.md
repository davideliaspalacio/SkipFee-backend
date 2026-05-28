# Backend — Plan de implementación

Backend del monorepo de **Bros and Subs**. Reemplazará los mocks del frontend (`frontend/src/lib/data.ts`) por servicios reales y, en una primera fase, integrará **Kapso** para recibir y enviar mensajes de WhatsApp (pantalla `WhatsApp.tsx`, banner "Bot pausado / Reanudar bot", tabs `todos / pendiente / humano / bot`).

> Estado actual: carpeta `backend/` reservada según el README raíz. El frontend opera contra mocks (`ORDERS`, `CHATS`, `CHAT_MESSAGES`, `CUSTOMERS`, `ZONES`, `PRODUCTS`) y muta estado vía `moveOrdersToStatus` con un mini pub/sub (`orders-changed`). Los tipos en `data.ts` son el contrato de facto.

---

## 1. Stack

| Capa | Elección | Razón |
|------|----------|-------|
| Framework | **Next.js 15+ (App Router)** | API routes + posibilidad de vistas server-rendered en el futuro. Mismo TS que frontend. |
| Lenguaje | TypeScript estricto | Mantiene el contrato con `frontend/src/lib/data.ts`. |
| ORM | **Prisma** | Migraciones + tipos generados; encaja con Postgres/Supabase. |
| BD | **PostgreSQL** (Supabase como default) | Servidor MCP de Supabase ya disponible localmente. |
| Validación | **Zod** | Para parsear payloads de webhook y entradas de API. |
| WhatsApp | **`@kapso/whatsapp-cloud-api`** | SDK oficial; `baseUrl: https://app.kapso.ai/api/meta/` + `kapsoApiKey`. |
| Runtime | **Node.js** (no Edge) en el webhook | Necesitamos `crypto` y acceso al body raw para HMAC. |

---

## 2. Estructura de carpetas

```
backend/
  prisma/
    schema.prisma
    seed.ts
  src/
    app/
      api/
        health/route.ts                # GET — healthcheck
        webhooks/
          kapso/route.ts               # POST — eventos de Kapso (HMAC SHA256)
        orders/
          route.ts                     # GET, POST
          [id]/route.ts                # GET, PATCH (mover de estado)
        chats/
          route.ts                     # GET
          [id]/
            messages/route.ts          # GET, POST (envío vía Kapso)
            takeover/route.ts          # POST — pausar bot
            release/route.ts           # POST — reanudar bot
        customers/route.ts
        zones/route.ts
        products/route.ts
        reports/sales/route.ts
    lib/
      kapso/
        client.ts                      # WhatsAppClient configurado
        verify.ts                      # HMAC SHA256 + timingSafeEqual
        events.ts                      # tipos de payload Kapso
        handlers/
          message-received.ts
          message-status.ts
      db.ts                            # Prisma singleton
      env.ts                           # validación de env con Zod
      types.ts                         # tipos compartidos con frontend
  .env.example
  next.config.ts
  tsconfig.json
  package.json
```

---

## 3. Variables de entorno

```bash
# Postgres
DATABASE_URL=postgresql://...
DIRECT_URL=postgresql://...           # para prisma migrate (Supabase)

# Kapso
KAPSO_API_KEY=...                     # apunta SDK a https://app.kapso.ai/api/meta/
KAPSO_WEBHOOK_SECRET=...              # HMAC SHA256 (header X-Webhook-Signature)
KAPSO_PHONE_NUMBER_ID=...             # número emisor de WhatsApp

# App
NEXT_PUBLIC_APP_ORIGIN=http://localhost:3000
NODE_ENV=development
```

Validadas en `src/lib/env.ts` con Zod. Si falta una, el server falla al arrancar.

---

## 4. Modelo de datos (Prisma)

Espejo directo de los tipos del frontend para preservar el contrato:

- **Zone** — `id, name, tarifa, recargo, color, lat, lng`
- **Product** — `id, name, price, cat, sold, available, img`
- **Customer** — `id, name, phone, addr, zoneId, ticketAvg, rating, tag` (enum: `VIP | Recurrente | Nuevo`)
- **Order** — `id, customerId, total, zoneId, status, createdAt, address, paymentMethod, note, lat, lng` + `OrderItem`
- **OrderStatus** — enum `nuevo | pagado | cocina | empacado | ruta | entregado` (coincide con `StatusId`)
- **Chat** — `id, customerId?, phone, status, zoneId?, lastMessageAt, unread`
- **ChatStatus** — enum `bot | human | pending`
- **Message** — `id, chatId, direction (in|out|bot), body, mediaUrl?, kapsoMessageId, createdAt, deliveredAt?, readAt?`
- **WebhookEvent** — `idempotencyKey (PK), type, payload, processedAt` para dedup

---

## 5. Integración Kapso

### 5.1 Recepción de webhooks

`POST /api/webhooks/kapso` (runtime Node, no Edge):

1. Leer el body **raw** (Next `await request.text()` antes de parsear).
2. Verificar `X-Webhook-Signature` con HMAC SHA256 (`KAPSO_WEBHOOK_SECRET`) y `crypto.timingSafeEqual`.
3. Dedup por `X-Idempotency-Key` en tabla `WebhookEvent`.
4. Despachar por `X-Webhook-Event`:
   - `whatsapp.message.received` → upsert `Chat` + insert `Message direction=in`. Si `Chat.status === 'bot'`, delegar a la lógica del bot (Fase 2; primero Kapso Workflow, después Agent Node).
   - `whatsapp.message.status` → update `Message.deliveredAt | readAt`.
5. **Responder 200 en <10s**. Procesamiento pesado a cola en Fase 2 (BullMQ + Redis, o cola en BD).

### 5.2 Envío de mensajes

`lib/kapso/client.ts`:

```ts
import { WhatsAppClient } from '@kapso/whatsapp-cloud-api';
import { env } from '../env';

export const kapso = new WhatsAppClient({
  baseUrl: 'https://app.kapso.ai/api/meta/',
  kapsoApiKey: env.KAPSO_API_KEY,
});
```

Endpoint interno: `POST /api/chats/:id/messages { body }` → `kapso.messages.sendText({ phoneNumberId, to, body })` + persistir `Message direction=out`.

### 5.3 Bot vs Humano

El frontend ya distingue `status: 'bot' | 'human' | 'pending'` (ver `CHATS` en `data.ts:212`). Se mapea a `Chat.status`:

- `bot` → el handler delega a la lógica automatizada.
- `human` / `pending` → solo persistimos el mensaje; el operador responde desde el panel.
- `POST /api/chats/:id/takeover` → `status = 'human'` (botón "Tomar conversación" en `WhatsApp.tsx:129`).
- `POST /api/chats/:id/release` → vuelve a `bot` (botón "Reanudar bot" en `WhatsApp.tsx:108`).

---

## 6. Contrato con el frontend

Los tipos en `frontend/src/lib/data.ts` son la **fuente de verdad** del contrato. El backend devuelve JSON con la misma forma. Cuando migremos:

- `import { ORDERS } from '../lib/data'` → `useQuery('/api/orders')`.
- `moveOrdersToStatus(ids, status)` (en `frontend/src/lib/orders.ts:5`) → `PATCH /api/orders/:id { status }`. La firma `(ids, status) => Promise<void>` permanece — el evento `orders-changed` es reemplazado por invalidación de query / suscripción.
- Componentes y CSS no se tocan; reciben los mismos shapes.

---

## 7. Fases de entrega

**Fase 0 — Andamiaje (este cambio)**

- [ ] `create-next-app` en `backend/`
- [ ] `.env.example` + `lib/env.ts`
- [ ] `GET /api/health` — healthcheck
- [ ] `POST /api/webhooks/kapso` — verificación HMAC + log estructurado (sin DB todavía)
- [ ] `lib/kapso/client.ts` con SDK instalado
- [ ] README mínimo del backend con instrucciones de dev

**Fase 1 — Persistencia mínima**

- Prisma + Postgres (Supabase)
- Modelos del §4
- Seed con datos equivalentes a los mocks
- CRUD básico de `orders` / `chats` / `messages` / `customers` / `zones` / `products`

**Fase 2 — Integración real con Kapso**

- Procesar `whatsapp.message.received` end-to-end
- Endpoint de envío desde el panel
- Pausar/reanudar bot por chat
- Workflow Kapso para flujo de pedido (saludo → carta → confirmación → link Wompi)

**Fase 3 — Migración del frontend**

- React Query en `frontend/`
- Reemplazar imports de `data.ts` por hooks
- Realtime para el kanban y la bandeja de WhatsApp (SSE o Supabase Realtime)

---

## 8. Decisiones a confirmar

1. **Cuenta Kapso**: ¿ya hay una activa o partimos del sandbox? Necesitamos `KAPSO_API_KEY`, `KAPSO_WEBHOOK_SECRET` y `KAPSO_PHONE_NUMBER_ID`.
2. **Base de datos**: ¿usamos Supabase (el MCP ya está conectado) o Postgres self-hosted?
3. **Hosting**: ¿Vercel para el backend + Supabase para BD, u otra cosa?
4. **Auth del panel admin**: ¿Supabase Auth, Clerk, o sin login por ahora (red interna)?
5. **Bot logic**: ¿lo construimos como Kapso Workflow visual o como Agent Node + funciones serverless? Lo más rápido es Workflow para el MVP.

Mientras no se confirme lo anterior, el código de Fase 0 queda neutro (no asume DB ni proveedor) — el webhook valida la firma y loguea, el SDK queda configurado pero sin enviar mensajes reales.
