/**
 * Adaptador Evolution API — canal NO OFICIAL (Baileys / WhatsApp Web).
 *
 * Para negocios que no pasan por la verificación de Meta. Conecta por QR.
 *
 * ⚠️ Riesgo aceptado: WhatsApp no permite clientes no oficiales. El número del
 *    negocio puede ser baneado. Es la opción de entrada, no la recomendada.
 *
 * Lo que hace distinto a Kapso:
 *   1. DEGRADA botones/listas/CTA a texto numerado (ver `../degrade.ts`) y
 *      persiste las opciones ofrecidas para poder interpretar la respuesta.
 *   2. Verifica el webhook con un token estático, no con HMAC.
 *   3. Tiene sesión: implementa `SessionCapableProvider`.
 */

import { chatIdFor } from '@/lib/messaging';
import type { SessionCapableProvider } from '../provider';
import type {
  InboundEnvelope,
  ProviderCapabilities,
  SendButtonsOpts,
  SendCtaUrlOpts,
  SendImageOpts,
  SendListOpts,
  SendResult,
  SendTextOpts,
  SessionInfo,
} from '../types';
import {
  flattenSections,
  renderCtaAsText,
  renderNumberedMenu,
} from '../degrade';
import { savePendingOptions } from '../pending';
import { EvolutionClient } from './client';
import { mapEvolutionState, parseEvolutionInbound } from './parse';

const CAPABILITIES: ProviderCapabilities = {
  // Baileys expone APIs de botones/listas, pero WhatsApp las ignora o entrega
  // roto según el motor y la versión. Las damos por NO soportadas y degradamos
  // siempre: un menú de texto que funciona vale más que un botón que a veces
  // llega. Si algún día el soporte se vuelve fiable, esto es lo único a cambiar.
  buttons: false,
  lists: false,
  ctaUrl: false,
  images: true,
  deliveryStatus: false,
  session: true,
};

export interface EvolutionProviderConfig {
  companyId: string;
  baseUrl: string;
  apiKey: string;
  instance: string;
  webhookToken: string | null;
}

export class EvolutionProvider implements SessionCapableProvider {
  readonly kind = 'evolution' as const;
  readonly capabilities = CAPABILITIES;
  readonly companyId: string;

  private readonly client: EvolutionClient;
  private readonly webhookToken: string | null;

  constructor(cfg: EvolutionProviderConfig) {
    this.companyId = cfg.companyId;
    this.webhookToken = cfg.webhookToken;
    this.client = new EvolutionClient({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      instance: cfg.instance,
    });
  }

  /** Evolution devuelve `key.id`; lo mapeamos al contrato interno de Kapso. */
  private static toSendResult(res: { key?: { id?: string } }): SendResult {
    return { messages: [{ id: res.key?.id }] };
  }

  async sendText(opts: SendTextOpts): Promise<SendResult> {
    const res = await this.client.sendText(opts.to, opts.body);
    return EvolutionProvider.toSendResult(res);
  }

  async sendImage(opts: SendImageOpts): Promise<SendResult> {
    const res = await this.client.sendMedia({
      to: opts.to,
      url: opts.link,
      caption: opts.caption,
    });
    return EvolutionProvider.toSendResult(res);
  }

  /**
   * Botones → menú numerado. Guarda las opciones para que la respuesta del
   * cliente ("2") se pueda mapear de vuelta al id del botón.
   */
  async sendButtons(opts: SendButtonsOpts): Promise<SendResult> {
    const { text, pending } = renderNumberedMenu({
      body: opts.body,
      options: opts.buttons.map(b => ({ id: b.id, title: b.title })),
      header: opts.header?.text,
      footer: opts.footer,
    });

    const res = await this.client.sendText(opts.to, text);
    // Después del envío: si el envío falla, no dejamos opciones huérfanas.
    await savePendingOptions(chatIdFor(this.companyId, opts.to), pending);
    return EvolutionProvider.toSendResult(res);
  }

  /** Listas → mismo menú numerado, aplanando las secciones. */
  async sendList(opts: SendListOpts): Promise<SendResult> {
    const { text, pending } = renderNumberedMenu({
      body: opts.body,
      options: flattenSections(opts.sections),
      header: opts.header,
      footer: opts.footer,
    });

    const res = await this.client.sendText(opts.to, text);
    await savePendingOptions(chatIdFor(this.companyId, opts.to), pending);
    return EvolutionProvider.toSendResult(res);
  }

  /**
   * CTA con URL → el link va en el cuerpo del texto. No genera opciones
   * pendientes: no hay nada que el cliente deba elegir.
   */
  async sendCtaUrl(opts: SendCtaUrlOpts): Promise<SendResult> {
    const text = renderCtaAsText({
      body: opts.body,
      displayText: opts.displayText,
      url: opts.url,
      header: opts.header,
      footer: opts.footer,
    });
    const res = await this.client.sendText(opts.to, text);
    return EvolutionProvider.toSendResult(res);
  }

  /**
   * Evolution no firma el body. Lo mejor disponible es un token compartido que
   * nosotros mismos ponemos en la URL del webhook al registrarla.
   *
   * Es más débil que el HMAC de Kapso: no prueba integridad del payload, solo
   * que quien llama conoce el secreto. Por eso la URL del webhook debe tratarse
   * como credencial y viajar siempre por HTTPS.
   */
  verifyWebhook(opts: { rawBody: string; headers: Headers }): boolean {
    if (!this.webhookToken) return false;
    const provided =
      opts.headers.get('x-evolution-token') ??
      opts.headers.get('apikey') ??
      opts.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
      null;
    if (!provided) return false;
    // Comparación de longitud constante sobre strings cortos.
    if (provided.length !== this.webhookToken.length) return false;
    let diff = 0;
    for (let i = 0; i < provided.length; i++) {
      diff |= provided.charCodeAt(i) ^ this.webhookToken.charCodeAt(i);
    }
    return diff === 0;
  }

  parseInbound(payload: unknown): InboundEnvelope | null {
    return parseEvolutionInbound(payload);
  }

  // ---------------------------------------------------------------------
  // Sesión
  // ---------------------------------------------------------------------

  async connectSession(): Promise<SessionInfo> {
    // `create` es idempotente en la práctica: si ya existe, Evolution responde
    // error y seguimos igual a pedir el QR.
    try {
      await this.client.createInstance();
    } catch {
      // instancia ya existente — no es un fallo real
    }
    const res = await this.client.connect();
    return {
      status: res.base64 ? 'connecting' : mapEvolutionState(res.instance?.state),
      qr: res.base64 ?? null,
    };
  }

  async getSession(): Promise<SessionInfo> {
    const res = await this.client.connectionState();
    return {
      status: mapEvolutionState(res.instance?.state ?? res.state),
      qr: null,
    };
  }

  async logoutSession(): Promise<void> {
    await this.client.logout();
  }

  /**
   * Registra la URL del webhook de esta empresa en el servidor Evolution,
   * incluyendo el token compartido como header.
   *
   * Este paso es el que hace que empiecen a ENTRAR pedidos: sin él Evolution
   * nunca nos avisa de los mensajes, la sesión se ve "conectada" y el bot
   * jamás responde.
   */
  async registerWebhook(url: string): Promise<void> {
    await this.client.setWebhook({
      url,
      headers: this.webhookToken
        ? { 'x-evolution-token': this.webhookToken }
        : undefined,
    });
  }
}
