import { WhatsAppClient } from '@kapso/whatsapp-cloud-api';
import { env } from '../env';

export const KAPSO_BASE_URL = 'https://app.kapso.ai/api/meta/';

/** Credenciales Kapso para construir un cliente (por empresa o desde el env). */
export interface KapsoClientCredentials {
  apiKey: string;
  /** phone_number_id por defecto para sendText/sendImage. */
  phoneNumberId?: string;
}

/** Cliente Kapso + helpers de envío ligados a un phone_number_id concreto. */
export interface KapsoClient {
  client: WhatsAppClient;
  sendText(to: string, body: string): ReturnType<WhatsAppClient['messages']['sendText']>;
  sendImage(
    to: string,
    link: string,
    caption?: string,
  ): ReturnType<WhatsAppClient['messages']['sendImage']>;
}

/**
 * Factory: construye un cliente Kapso a partir de credenciales explícitas.
 * Multi-empresa: `lib/integrations.ts` lo usa con las credenciales de cada
 * empresa. El env global ya NO es la fuente de verdad (ver `kapsoFor`).
 */
export function createKapsoClient(creds: KapsoClientCredentials): KapsoClient {
  const client = new WhatsAppClient({
    baseUrl: KAPSO_BASE_URL,
    kapsoApiKey: creds.apiKey,
  });
  const phoneNumberId = creds.phoneNumberId;
  return {
    client,
    sendText: (to: string, body: string) => {
      if (!phoneNumberId) throw new Error('Falta phoneNumberId para sendText.');
      return client.messages.sendText({ phoneNumberId, to, body });
    },
    sendImage: (to: string, link: string, caption?: string) => {
      if (!phoneNumberId) throw new Error('Falta phoneNumberId para sendImage.');
      return client.messages.sendImage({
        phoneNumberId,
        to,
        image: { link, ...(caption ? { caption } : {}) },
      });
    },
  };
}

// =========================================================================
// Compat / fallback al env global (callers legacy aún sin migrar a por-empresa).
// Estas exports leen `KAPSO_API_KEY` / `KAPSO_PHONE_NUMBER_ID`, que ahora son
// OPCIONALES en el env. Si faltan, el SDK/llamadas fallarán en runtime (igual
// que antes con credenciales inválidas), pero el server arranca igual.
// La ruta multi-empresa correcta es `kapsoFor(companyId)` de `lib/integrations`.
// =========================================================================

export const kapso = new WhatsAppClient({
  baseUrl: KAPSO_BASE_URL,
  kapsoApiKey: env.KAPSO_API_KEY,
});

export async function sendText(to: string, body: string) {
  return kapso.messages.sendText({
    phoneNumberId: env.KAPSO_PHONE_NUMBER_ID,
    to,
    body,
  });
}

export async function sendImage(to: string, link: string, caption?: string) {
  return kapso.messages.sendImage({
    phoneNumberId: env.KAPSO_PHONE_NUMBER_ID,
    to,
    image: { link, ...(caption ? { caption } : {}) },
  });
}
