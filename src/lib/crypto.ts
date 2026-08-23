import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cifrado en reposo de las credenciales de terceros (`company_integrations`).
 *
 * Qué protege y qué no. Estas columnas guardan las llaves de WhatsApp y de
 * Wompi de cada negocio: quien las lea puede escribir por su WhatsApp y firmar
 * cobros a su nombre. Cifrarlas no vuelve la tabla inexpugnable —la clave vive
 * en el entorno del backend, así que un atacante con ejecución de código en el
 * servidor las obtiene igual— pero sí corta los caminos por los que un secreto
 * se escapa de verdad: un volcado de la base, un backup viejo, una consulta
 * pegada en un chat, un `select *` en el SQL Editor con la pantalla compartida.
 *
 * Formato: `enc:v1:<iv>:<tag>:<datos>`, todo en base64url. AES-256-GCM, IV de
 * 12 bytes aleatorio por valor. El prefijo versionado permite rotar el algoritmo
 * más adelante sin adivinar qué es cada fila.
 *
 * **Transparente hacia atrás**: `descifrar` devuelve tal cual cualquier valor
 * que no lleve el prefijo. Así las filas que hoy están en texto plano siguen
 * funcionando mientras se migran, y no hay un momento en que todo esté roto.
 *
 * ⚠️ Si se pierde `CREDENTIALS_KEY` se pierden las credenciales: no hay forma de
 *    recuperarlas y cada negocio tendría que volver a cargarlas.
 */

const PREFIJO = 'enc:v1:';
const ALGO = 'aes-256-gcm';

let avisoSinClave = false;

/** La clave viene en base64 y debe pesar 32 bytes (AES-256). */
function clave(): Buffer | null {
  const raw = process.env.CREDENTIALS_KEY;
  if (!raw) return null;
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('CREDENTIALS_KEY no es base64 válido.');
  }
  if (key.length !== 32) {
    throw new Error(
      `CREDENTIALS_KEY debe ser de 32 bytes en base64 (son ${key.length}). ` +
        'Genera una con: openssl rand -base64 32',
    );
  }
  return key;
}

export function estaCifrado(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIJO);
}

/**
 * Cifra un secreto. Sin `CREDENTIALS_KEY` devuelve el valor tal cual y avisa una
 * vez: en desarrollo se prefiere que el alta funcione a que el servidor se caiga
 * por una variable que nadie configuró todavía. En producción la variable es
 * obligatoria (ver `docs`).
 */
export function cifrar(value: string): string;
export function cifrar(value: string | null | undefined): string | null;
export function cifrar(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (estaCifrado(value)) return value;

  const key = clave();
  if (!key) {
    if (!avisoSinClave) {
      avisoSinClave = true;
      console.warn(
        '[crypto] CREDENTIALS_KEY no configurada: las credenciales se guardan en texto plano.',
      );
    }
    return value;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const datos = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIJO}${iv.toString('base64url')}:${tag.toString('base64url')}:${datos.toString('base64url')}`;
}

/**
 * Descifra un secreto. Un valor sin prefijo se devuelve tal cual (texto plano
 * heredado).
 *
 * Si el valor SÍ está cifrado y no hay clave, lanza: devolver el criptograma
 * como si fuera una API key haría que el fallo apareciera más tarde y más lejos
 * —un webhook rechazado, un cobro sin firmar— en vez de aquí.
 */
export function descifrar(value: string): string;
export function descifrar(value: string | null | undefined): string | null;
export function descifrar(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (!estaCifrado(value)) return value;

  const key = clave();
  if (!key) {
    throw new Error(
      'Hay credenciales cifradas pero falta CREDENTIALS_KEY. El backend no puede operar sin ella.',
    );
  }

  const [iv, tag, datos] = value.slice(PREFIJO.length).split(':');
  if (!iv || !tag || !datos) throw new Error('Credencial cifrada con formato inválido.');

  const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(datos, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Columnas de `company_integrations` que son secretos.
 *
 * Deliberadamente NO están aquí la llave pública de Wompi (viaja al navegador
 * del comensal por diseño), ni el `phone_number_id`, ni la URL o el nombre de
 * instancia de Evolution: son identificadores, no llaves, y cifrarlos rompería
 * los índices que los buscan.
 */
export const COLUMNAS_SECRETAS = [
  'kapso_api_key',
  'kapso_webhook_secret',
  'evolution_api_key',
  'evolution_webhook_token',
  'wompi_integrity_secret',
  'wompi_events_secret',
] as const;

export type ColumnaSecreta = (typeof COLUMNAS_SECRETAS)[number];

/** Descifra en sitio las columnas secretas de una fila de integraciones. */
export function descifrarFila<T extends Record<string, unknown>>(fila: T): T {
  const salida = { ...fila };
  for (const col of COLUMNAS_SECRETAS) {
    const v = salida[col];
    if (typeof v === 'string') {
      (salida as Record<string, unknown>)[col] = descifrar(v);
    }
  }
  return salida;
}

/** Cifra las columnas secretas presentes en un patch antes de escribirlo. */
export function cifrarPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const salida = { ...patch };
  for (const col of COLUMNAS_SECRETAS) {
    const v = salida[col];
    if (typeof v === 'string' && v) salida[col] = cifrar(v);
  }
  return salida;
}
