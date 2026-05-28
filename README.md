# Backend — Bros and Subs

API y webhook receiver del panel admin. Stack: **Next.js 16 (App Router) + TypeScript**. Reemplazará los mocks de `frontend/src/lib/data.ts` y será el receptor de eventos de Kapso para WhatsApp.

> **Estado:** Fase 0 — andamiaje. Ver [`PLAN.md`](./PLAN.md) para el roadmap completo.

## Quick start

```bash
npm install
cp .env.example .env.local   # llenar KAPSO_* y volver
npm run dev                  # http://localhost:3000
```

Healthcheck:

```bash
curl http://localhost:3000/api/health
```

## Variables de entorno

Ver [`.env.example`](./.env.example). Las variables `KAPSO_*` se validan al arranque con Zod (`src/lib/env.ts`) — si falta una, el server falla.

| Variable | Para |
|----------|------|
| `KAPSO_API_KEY` | Autentica el SDK contra `https://app.kapso.ai/api/meta/` |
| `KAPSO_WEBHOOK_SECRET` | HMAC SHA256 que valida `X-Webhook-Signature` |
| `KAPSO_PHONE_NUMBER_ID` | Número emisor de WhatsApp |

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET`  | `/api/health` | Healthcheck (no requiere auth) |
| `POST` | `/api/webhooks/kapso` | Receptor de eventos de Kapso. Verifica `X-Webhook-Signature` antes de procesar. |

## Probar el webhook localmente

El receptor está en `src/app/api/webhooks/kapso/route.ts`. Para probarlo, expón el dev server con un túnel (ngrok, cloudflared, etc.):

```bash
# Terminal 1
npm run dev

# Terminal 2
ngrok http 3000
# → registra la URL https://<id>.ngrok-free.app/api/webhooks/kapso en el dashboard de Kapso
```

Generar una firma válida desde Node (para tests manuales):

```ts
import { createHmac } from 'node:crypto';
const body = JSON.stringify({ hello: 'world' });
const sig = createHmac('sha256', process.env.KAPSO_WEBHOOK_SECRET!).update(body).digest('hex');
```

```bash
curl -X POST http://localhost:3000/api/webhooks/kapso \
  -H 'Content-Type: application/json' \
  -H 'X-Webhook-Event: whatsapp.message.received' \
  -H 'X-Idempotency-Key: test-1' \
  -H "X-Webhook-Signature: $SIG" \
  -d "$BODY"
```

Sin firma válida → `401`. Body inválido → `400`. Éxito → `200` con `ok`.

## Estructura

```
src/
  app/
    api/
      health/route.ts
      webhooks/kapso/route.ts
    layout.tsx
    page.tsx
  lib/
    env.ts                # zod schema para process.env
    kapso/
      client.ts           # WhatsAppClient (baseUrl Kapso)
      verify.ts           # HMAC SHA256 timing-safe
      events.ts           # tipos de eventos
```

## Scripts

| Script | Para |
|--------|------|
| `npm run dev` | Servidor de desarrollo (Turbopack) |
| `npm run build` | Build de producción |
| `npm run start` | Sirve el build |
| `npm run lint` | ESLint |
