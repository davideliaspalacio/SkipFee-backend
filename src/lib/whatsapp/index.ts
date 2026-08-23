/**
 * Punto de entrada del puerto de WhatsApp.
 *
 * El resto del backend importa SOLO desde aquí. Nadie debe importar
 * `@/lib/kapso/*` ni `./evolution/client` directamente: hacerlo se salta la
 * abstracción y rompe a las empresas que usan el otro proveedor.
 */

export * from './types';
export { isSessionCapable } from './provider';
export type {
  ProviderKind,
  SessionCapableProvider,
  WhatsAppProvider,
} from './provider';
export { providerFor, providerKindFor } from './factory';
export {
  matchPendingOption,
  normalizeReply,
  renderNumberedMenu,
  type PendingOption,
  type PendingOptions,
} from './degrade';
export {
  clearPendingOptions,
  loadPendingOptions,
  savePendingOptions,
} from './pending';
