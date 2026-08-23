/**
 * Capa de envío del bot — CONSCIENTE DE EMPRESA Y DE PROVEEDOR.
 *
 * Los handlers del flow envían todo por acá y no saben (ni deben saber) si la
 * empresa habla por Kapso (Cloud API oficial) o por Evolution (canal no oficial
 * por QR). Esa decisión la toma `providerFor(companyId)`.
 *
 * Si el proveedor no soporta un formato interactivo, su adaptador lo DEGRADA a
 * texto (menú numerado) — nunca falla por falta de capability. Ver
 * `lib/whatsapp/degrade.ts`.
 *
 * Compat: si `companyId` es undefined (callers/tests legacy aún sin migrar) cae
 * a los helpers globales `lib/kapso/*` que leen el env. Los tests del flow
 * mockean esos módulos, así que ese camino debe conservarse hasta que la
 * migración multi-empresa esté cerrada del todo.
 */

import { providerFor } from '@/lib/whatsapp';
import type { ListSection, ReplyButton, SendResult } from '@/lib/whatsapp';
import { sendText as legacySendText } from '@/lib/kapso/client';
import {
  sendButtons as legacySendButtons,
  sendList as legacySendList,
  sendCtaUrl as legacySendCtaUrl,
} from '@/lib/kapso/interactive';

export type { SendResult, ReplyButton, ListSection };

export async function botSendTextMsg(
  companyId: string | undefined,
  to: string,
  body: string,
): Promise<SendResult> {
  if (!companyId) return legacySendText(to, body);
  const provider = await providerFor(companyId);
  return provider.sendText({ to, body });
}

export async function botSendImageMsg(
  companyId: string | undefined,
  opts: { to: string; link: string; caption?: string },
): Promise<SendResult> {
  if (!companyId) {
    const { sendImage } = await import('@/lib/kapso/client');
    return sendImage(opts.to, opts.link, opts.caption);
  }
  const provider = await providerFor(companyId);
  return provider.sendImage(opts);
}

export async function botSendButtonsMsg(
  companyId: string | undefined,
  opts: {
    to: string;
    body: string;
    buttons: ReplyButton[];
    footer?: string;
    header?: { type: 'text'; text: string };
  },
): Promise<SendResult> {
  if (!companyId) return legacySendButtons(opts);
  const provider = await providerFor(companyId);
  return provider.sendButtons(opts);
}

export async function botSendListMsg(
  companyId: string | undefined,
  opts: {
    to: string;
    body: string;
    buttonText: string;
    sections: ListSection[];
    header?: string;
    footer?: string;
  },
): Promise<SendResult> {
  if (!companyId) return legacySendList(opts);
  const provider = await providerFor(companyId);
  return provider.sendList(opts);
}

export async function botSendCtaUrlMsg(
  companyId: string | undefined,
  opts: {
    to: string;
    body: string;
    displayText: string;
    url: string;
    header?: string;
    footer?: string;
  },
): Promise<SendResult> {
  if (!companyId) return legacySendCtaUrl(opts);
  const provider = await providerFor(companyId);
  return provider.sendCtaUrl(opts);
}
