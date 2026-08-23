/**
 * Fábrica de proveedores: `providerFor(companyId)` → el adaptador correcto.
 *
 * Único punto del backend que decide "¿esta empresa habla por Kapso o por
 * Evolution?". Todo lo demás recibe un `WhatsAppProvider` y no pregunta.
 *
 * La lectura de credenciales pasa por `getCompanyIntegrations`, que ya cachea
 * en memoria con TTL de 30s — no añadimos otra capa de cache aquí. Los objetos
 * adaptador son baratos de construir (solo envuelven config), así que se crean
 * por llamada en vez de mantener un pool que habría que invalidar.
 */

import {
  evolutionCredentialsFor,
  getCompanyIntegrations,
  kapsoCredentialsFor,
} from '@/lib/integrations';
import { EvolutionProvider } from './evolution/adapter';
import { KapsoProvider } from './kapso/adapter';
import type { ProviderKind, WhatsAppProvider } from './provider';

/** Devuelve qué proveedor tiene configurado una empresa. */
export async function providerKindFor(companyId: string): Promise<ProviderKind> {
  const row = await getCompanyIntegrations(companyId);
  return row.whatsapp_provider === 'evolution' ? 'evolution' : 'kapso';
}

/**
 * Construye el proveedor de WhatsApp de una empresa.
 * Lanza `MissingIntegrationError` si faltan credenciales del proveedor elegido.
 */
export async function providerFor(companyId: string): Promise<WhatsAppProvider> {
  const kind = await providerKindFor(companyId);

  if (kind === 'evolution') {
    const creds = await evolutionCredentialsFor(companyId);
    return new EvolutionProvider({
      companyId,
      baseUrl: creds.baseUrl,
      apiKey: creds.apiKey,
      instance: creds.instance,
      webhookToken: creds.webhookToken,
    });
  }

  const creds = await kapsoCredentialsFor(companyId);
  return new KapsoProvider({
    companyId,
    apiKey: creds.apiKey,
    phoneNumberId: creds.phoneNumberId,
    webhookSecret: creds.webhookSecret,
  });
}
