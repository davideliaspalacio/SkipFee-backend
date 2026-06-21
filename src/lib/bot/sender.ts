import { kapsoFor } from '@/lib/integrations';
import {
  sendText as legacySendText,
} from '@/lib/kapso/client';
import {
  sendButtons as legacySendButtons,
  sendList as legacySendList,
  sendCtaUrl as legacySendCtaUrl,
  type ReplyButton,
  type ListSection,
} from '@/lib/kapso/interactive';

/**
 * Capa de envío del bot CONSCIENTE DE EMPRESA.
 *
 * El bot manda mensajes por el número de WhatsApp de la empresa dueña del chat.
 * Cuando recibe `companyId`, resuelve el cliente Kapso de esa empresa con
 * `kapsoFor(companyId)` (lee `company_integrations`) y envía con SU
 * `phone_number_id`. El SDK de Kapso (`WhatsAppClient`) expone los métodos
 * interactivos (`sendInteractive*`), así que el bot construye los payloads acá
 * sin depender de los helpers globales de `lib/kapso/*` (que usan el env).
 *
 * Compat: si `companyId` es undefined (callers/tests legacy aún sin migrar),
 * cae a los helpers globales `lib/kapso/*` (env `KAPSO_PHONE_NUMBER_ID`). Así
 * los tests del flow que mockean `@/lib/kapso/*` siguen funcionando sin cambios.
 *
 * Todas las funciones devuelven `{ messages?: [{ id? }] }` (forma de Kapso) para
 * que los handlers extraigan el `wamid` igual que antes.
 */

export interface SendResult {
  messages?: Array<{ id?: string }>;
}

function buildHeader(header?: { type: 'text'; text: string }) {
  if (!header) return undefined;
  return { type: 'text' as const, text: header.text };
}

export async function botSendTextMsg(
  companyId: string | undefined,
  to: string,
  body: string,
): Promise<SendResult> {
  if (!companyId) return legacySendText(to, body);
  const kapso = await kapsoFor(companyId);
  return kapso.sendText(to, body);
}

export async function botSendButtonsMsg(
  companyId: string | undefined,
  opts: { to: string; body: string; buttons: ReplyButton[]; footer?: string; header?: { type: 'text'; text: string } },
): Promise<SendResult> {
  if (!companyId) return legacySendButtons(opts);
  const kapso = await kapsoFor(companyId);
  return kapso.client.messages.sendInteractiveButtons({
    phoneNumberId: kapso.phoneNumberId,
    to: opts.to,
    bodyText: opts.body,
    buttons: opts.buttons,
    footerText: opts.footer,
    header: buildHeader(opts.header),
  });
}

export async function botSendListMsg(
  companyId: string | undefined,
  opts: { to: string; body: string; buttonText: string; sections: ListSection[]; header?: string; footer?: string },
): Promise<SendResult> {
  if (!companyId) return legacySendList(opts);
  const kapso = await kapsoFor(companyId);
  return kapso.client.messages.sendInteractiveList({
    phoneNumberId: kapso.phoneNumberId,
    to: opts.to,
    bodyText: opts.body,
    buttonText: opts.buttonText,
    sections: opts.sections,
    header: opts.header ? { type: 'text', text: opts.header } : undefined,
    footerText: opts.footer,
  });
}

export async function botSendCtaUrlMsg(
  companyId: string | undefined,
  opts: { to: string; body: string; displayText: string; url: string; header?: string; footer?: string },
): Promise<SendResult> {
  if (!companyId) return legacySendCtaUrl(opts);
  const kapso = await kapsoFor(companyId);
  return kapso.client.messages.sendInteractiveCtaUrl({
    phoneNumberId: kapso.phoneNumberId,
    to: opts.to,
    bodyText: opts.body,
    parameters: { displayText: opts.displayText, url: opts.url },
    header: opts.header ? { type: 'text', text: opts.header } : undefined,
    footerText: opts.footer,
  });
}
