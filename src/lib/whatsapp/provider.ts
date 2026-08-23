/**
 * El PUERTO: la interfaz que todo proveedor de WhatsApp debe cumplir.
 *
 * Hay dos implementaciones: `KapsoProvider` (Cloud API oficial de Meta, vía
 * Kapso) y `EvolutionProvider` (Evolution API self-hosted, protocolo no oficial).
 * El bot y el resto del backend hablan SOLO con esta interfaz; nadie más debe
 * importar `@/lib/kapso/*` ni el cliente de Evolution directamente.
 *
 * Lo que NO va acá: el manejo de sesión/QR. Kapso no tiene ese concepto, así
 * que meterlo en el puerto obligaría a una implementación falsa. Vive aparte,
 * en `SessionCapableProvider`, y solo lo implementa Evolution.
 */

import type {
  ProviderCapabilities,
  SendButtonsOpts,
  SendCtaUrlOpts,
  SendImageOpts,
  SendListOpts,
  SendResult,
  SendTextOpts,
  SessionInfo,
  InboundEnvelope,
} from './types';

export type ProviderKind = 'kapso' | 'evolution';

export interface WhatsAppProvider {
  readonly kind: ProviderKind;
  /** Empresa dueña de este proveedor. */
  readonly companyId: string;
  readonly capabilities: ProviderCapabilities;

  sendText(opts: SendTextOpts): Promise<SendResult>;
  sendImage(opts: SendImageOpts): Promise<SendResult>;

  /**
   * Los tres siguientes SIEMPRE funcionan. Si el proveedor no soporta el
   * formato nativo, el adaptador degrada a texto (ver `degrade.ts`) — nunca
   * lanza por falta de capability.
   */
  sendButtons(opts: SendButtonsOpts): Promise<SendResult>;
  sendList(opts: SendListOpts): Promise<SendResult>;
  sendCtaUrl(opts: SendCtaUrlOpts): Promise<SendResult>;

  /**
   * Valida la autenticidad de un webhook entrante. Kapso firma el body con
   * HMAC-SHA256; Evolution manda un token estático en header. Cada adaptador
   * sabe lo suyo.
   */
  verifyWebhook(opts: {
    rawBody: string;
    headers: Headers;
  }): boolean;

  /**
   * Traduce el payload crudo del webhook a la forma normalizada.
   * Devuelve `null` si el evento no es un mensaje entrante que nos interese
   * (acuses, eventos de grupo, mensajes propios, etc.).
   */
  parseInbound(payload: unknown): InboundEnvelope | null;
}

/** Proveedores con sesión que puede caerse (hoy: solo Evolution). */
export interface SessionCapableProvider extends WhatsAppProvider {
  /** Crea/conecta la instancia y devuelve el QR si hay que escanear. */
  connectSession(): Promise<SessionInfo>;
  getSession(): Promise<SessionInfo>;
  logoutSession(): Promise<void>;
}

export function isSessionCapable(
  p: WhatsAppProvider,
): p is SessionCapableProvider {
  return p.capabilities.session && 'connectSession' in p;
}
