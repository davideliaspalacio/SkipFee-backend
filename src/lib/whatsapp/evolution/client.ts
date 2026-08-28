/**
 * Cliente HTTP de Evolution API (self-hosted, v2).
 *
 * Evolution NO tiene SDK oficial de Node, así que hablamos REST directo.
 * Autenticación: header `apikey`. Cada empresa apunta a su propia instancia
 * dentro del servidor Evolution (`instanceName`).
 *
 * ⚠️ Evolution corre sobre el protocolo NO OFICIAL de WhatsApp Web (Baileys).
 *    Meta no lo permite: hay riesgo real de baneo del número.
 *
 * Docs: https://doc.evolution-api.com/
 */

/** Timeout por request. Evolution puede colgarse si la sesión está caída. */
const REQUEST_TIMEOUT_MS = 15_000;

export class EvolutionApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly bodyText: string,
  ) {
    super(`Evolution API ${status} en ${path}: ${bodyText.slice(0, 300)}`);
    this.name = 'EvolutionApiError';
  }
}

export interface EvolutionConfig {
  baseUrl: string;
  apiKey: string;
  instance: string;
}

/** Respuesta de envío de Evolution. `key.id` es el equivalente al wamid. */
interface EvolutionSendResponse {
  key?: { id?: string; remoteJid?: string; fromMe?: boolean };
  status?: string;
}

/** Estado de conexión que reporta Evolution. */
interface EvolutionStateResponse {
  instance?: { instanceName?: string; state?: string };
  state?: string;
}

/** Respuesta de `instance/connect`: el QR para escanear. */
interface EvolutionConnectResponse {
  base64?: string;
  code?: string;
  pairingCode?: string | null;
  instance?: { state?: string };
}

export class EvolutionClient {
  constructor(private readonly cfg: EvolutionConfig) {}

  private url(path: string): string {
    const base = this.cfg.baseUrl.replace(/\/+$/, '');
    return `${base}${path}`;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(this.url(path), {
        method,
        headers: {
          apikey: this.cfg.apiKey,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) throw new EvolutionApiError(res.status, path, text);
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return {} as T;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Normaliza el destinatario al formato que espera Evolution: solo dígitos.
   * Acepta "+57 300 123 4567" o "573001234567@s.whatsapp.net".
   */
  static normalizeNumber(to: string): string {
    // Un LID no es un teléfono. Si se le quita el sufijo, Evolution asume
    // `@s.whatsapp.net` y responde `exists: false` — que es exactamente cómo se
    // rompía: el mensaje entraba bien y la respuesta se iba a un destino
    // inexistente. El sufijo viaja intacto.
    if (to.endsWith('@lid')) return to;
    return to.split('@')[0].replace(/\D/g, '');
  }

  async sendText(to: string, text: string): Promise<EvolutionSendResponse> {
    return this.request<EvolutionSendResponse>(
      'POST',
      `/message/sendText/${this.cfg.instance}`,
      { number: EvolutionClient.normalizeNumber(to), text },
    );
  }

  async sendMedia(opts: {
    to: string;
    url: string;
    caption?: string;
    mediatype?: 'image' | 'video' | 'document';
  }): Promise<EvolutionSendResponse> {
    return this.request<EvolutionSendResponse>(
      'POST',
      `/message/sendMedia/${this.cfg.instance}`,
      {
        number: EvolutionClient.normalizeNumber(opts.to),
        mediatype: opts.mediatype ?? 'image',
        media: opts.url,
        ...(opts.caption ? { caption: opts.caption } : {}),
      },
    );
  }

  // ---------------------------------------------------------------------
  // Sesión — lo que Kapso no tiene
  // ---------------------------------------------------------------------

  /** Crea la instancia si no existe. Idempotente en la práctica. */
  async createInstance(): Promise<unknown> {
    return this.request('POST', '/instance/create', {
      instanceName: this.cfg.instance,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    });
  }

  /** Conecta y devuelve el QR (base64) si hace falta escanear. */
  async connect(): Promise<EvolutionConnectResponse> {
    return this.request<EvolutionConnectResponse>(
      'GET',
      `/instance/connect/${this.cfg.instance}`,
    );
  }

  async connectionState(): Promise<EvolutionStateResponse> {
    return this.request<EvolutionStateResponse>(
      'GET',
      `/instance/connectionState/${this.cfg.instance}`,
    );
  }

  async logout(): Promise<void> {
    await this.request('DELETE', `/instance/logout/${this.cfg.instance}`);
  }

  /**
   * Registra la URL de webhook de esta instancia en el servidor Evolution.
   *
   * `headers` es lo que hace posible autenticar el webhook: Evolution los
   * reenvía en cada POST, y ahí viaja el token compartido que valida
   * `EvolutionProvider.verifyWebhook`. Sin esto, todo entrante se rechaza
   * con 401 y no entra ni un pedido.
   */
  async setWebhook(opts: {
    url: string;
    events?: string[];
    headers?: Record<string, string>;
  }): Promise<unknown> {
    return this.request('POST', `/webhook/set/${this.cfg.instance}`, {
      webhook: {
        enabled: true,
        url: opts.url,
        webhookByEvents: false,
        ...(opts.headers ? { headers: opts.headers } : {}),
        events: opts.events ?? ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
      },
    });
  }
}
