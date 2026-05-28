import { WhatsAppClient } from '@kapso/whatsapp-cloud-api';
import { env } from '../env';

export const KAPSO_BASE_URL = 'https://app.kapso.ai/api/meta/';

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
