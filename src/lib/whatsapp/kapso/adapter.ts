/**
 * Adaptador Kapso — WhatsApp Cloud API OFICIAL de Meta.
 *
 * Es el proveedor recomendado: número verificado, botones y listas nativos,
 * acuses de entrega, sin riesgo de baneo. Envuelve el SDK `@kapso/whatsapp-cloud-api`
 * con las credenciales de UNA empresa.
 *
 * Este adaptador es fino a propósito: la forma de sus respuestas ya ES el
 * contrato interno (`SendResult`), porque el contrato nació de Kapso.
 */

import { WhatsAppClient } from '@kapso/whatsapp-cloud-api';
import { KAPSO_BASE_URL } from './constants';
import { verifyKapsoSignature } from '@/lib/kapso/verify';
import type { WhatsAppProvider } from '../provider';
import type {
  InboundEnvelope,
  ProviderCapabilities,
  SendButtonsOpts,
  SendCtaUrlOpts,
  SendImageOpts,
  SendListOpts,
  SendResult,
  SendTextOpts,
} from '../types';
import { parseKapsoInbound } from './parse';

const CAPABILITIES: ProviderCapabilities = {
  buttons: true,
  lists: true,
  ctaUrl: true,
  images: true,
  deliveryStatus: true,
  session: false, // la Cloud API no tiene sesión que se caiga
};

export interface KapsoProviderConfig {
  companyId: string;
  apiKey: string;
  phoneNumberId: string;
  webhookSecret: string | null;
}

export class KapsoProvider implements WhatsAppProvider {
  readonly kind = 'kapso' as const;
  readonly capabilities = CAPABILITIES;
  readonly companyId: string;

  private readonly client: WhatsAppClient;
  private readonly phoneNumberId: string;
  private readonly webhookSecret: string | null;

  constructor(cfg: KapsoProviderConfig) {
    this.companyId = cfg.companyId;
    this.phoneNumberId = cfg.phoneNumberId;
    this.webhookSecret = cfg.webhookSecret;
    this.client = new WhatsAppClient({
      baseUrl: KAPSO_BASE_URL,
      kapsoApiKey: cfg.apiKey,
    });
  }

  sendText(opts: SendTextOpts): Promise<SendResult> {
    return this.client.messages.sendText({
      phoneNumberId: this.phoneNumberId,
      to: opts.to,
      body: opts.body,
    });
  }

  sendImage(opts: SendImageOpts): Promise<SendResult> {
    return this.client.messages.sendImage({
      phoneNumberId: this.phoneNumberId,
      to: opts.to,
      image: { link: opts.link, ...(opts.caption ? { caption: opts.caption } : {}) },
    });
  }

  sendButtons(opts: SendButtonsOpts): Promise<SendResult> {
    return this.client.messages.sendInteractiveButtons({
      phoneNumberId: this.phoneNumberId,
      to: opts.to,
      bodyText: opts.body,
      buttons: opts.buttons,
      footerText: opts.footer,
      header: opts.header ? { type: 'text', text: opts.header.text } : undefined,
    });
  }

  sendList(opts: SendListOpts): Promise<SendResult> {
    return this.client.messages.sendInteractiveList({
      phoneNumberId: this.phoneNumberId,
      to: opts.to,
      bodyText: opts.body,
      buttonText: opts.buttonText,
      sections: opts.sections,
      header: opts.header ? { type: 'text', text: opts.header } : undefined,
      footerText: opts.footer,
    });
  }

  sendCtaUrl(opts: SendCtaUrlOpts): Promise<SendResult> {
    return this.client.messages.sendInteractiveCtaUrl({
      phoneNumberId: this.phoneNumberId,
      to: opts.to,
      bodyText: opts.body,
      parameters: { displayText: opts.displayText, url: opts.url },
      header: opts.header ? { type: 'text', text: opts.header } : undefined,
      footerText: opts.footer,
    });
  }

  verifyWebhook(opts: { rawBody: string; headers: Headers }): boolean {
    if (!this.webhookSecret) return false;
    return verifyKapsoSignature({
      rawBody: opts.rawBody,
      signature: opts.headers.get('x-webhook-signature'),
      secret: this.webhookSecret,
    });
  }

  parseInbound(payload: unknown): InboundEnvelope | null {
    return parseKapsoInbound(payload);
  }
}
