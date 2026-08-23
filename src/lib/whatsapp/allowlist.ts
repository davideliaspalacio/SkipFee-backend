/**
 * Lista blanca de números de WhatsApp — cinturón de seguridad para desarrollo.
 *
 * Probar el bot en local es probarlo contra WhatsApp de verdad: no hay sandbox.
 * El número del negocio es el mismo que usan sus clientes, así que un mensaje
 * de una señora pidiendo un sándwich mientras alguien depura el flujo termina
 * contestado por una máquina a medio armar — o peor, por una que le crea un
 * pedido. Evolution lo empeora: la sesión vive donde se escaneó el QR, que en
 * pruebas suele ser un teléfono real con conversaciones reales.
 *
 * Con `WHATSAPP_ALLOWLIST` puesta, el bot solo le CONTESTA a esos números.
 * Todo lo demás se sigue guardando y se ve en el panel: no se pierde nada, solo
 * no sale respuesta automática. Un humano puede responder a mano desde la
 * bandeja como siempre.
 *
 * **Vacía o sin definir = todos.** Es el comportamiento de producción y es el
 * default, para que olvidarse de esta variable nunca deje a un negocio mudo.
 */

/** Se lee de `process.env` en cada llamada para que los tests puedan moverla. */
function crudo(): string {
  return process.env.WHATSAPP_ALLOWLIST ?? '';
}

/**
 * Deja solo los dígitos y se queda con los últimos 10.
 *
 * Un mismo teléfono llega escrito de varias formas según por dónde entre:
 * `3013589021` como lo escribe un colombiano, `573013589021` como lo manda
 * Evolution, `+57 301 358 9021` como lo guarda un contacto. Comparar las
 * cadenas tal cual haría que la lista blanca fallara justo cuando importa, así
 * que se comparan los últimos 10 dígitos — el número nacional, que en Colombia
 * identifica de forma única.
 */
function clave(valor: string): string {
  const digitos = valor.replace(/\D/g, '');
  return digitos.slice(-10);
}

/** Los números permitidos, ya normalizados. Vacío = no hay filtro. */
export function listaBlanca(): string[] {
  return crudo()
    .split(',')
    .map(n => clave(n.trim()))
    .filter(n => n.length === 10);
}

/** ¿Hay filtro activo? */
export function filtroActivo(): boolean {
  return listaBlanca().length > 0;
}

/**
 * ¿Se le puede contestar a este número?
 *
 * Sin filtro configurado, siempre sí.
 */
export function numeroPermitido(telefono: string | undefined | null): boolean {
  const permitidos = listaBlanca();
  if (permitidos.length === 0) return true;
  if (!telefono) return false;
  return permitidos.includes(clave(telefono));
}

/**
 * Aviso único al arrancar, para que nadie depure durante media hora un bot que
 * está callado a propósito. En producción se grita más fuerte: si esta variable
 * llegó ahí por accidente, el negocio dejó de responderle a sus clientes.
 */
let avisado = false;
export function avisarSiFiltroActivo(): void {
  if (avisado || !filtroActivo()) return;
  avisado = true;
  const numeros = listaBlanca().join(', ');
  if (process.env.NODE_ENV === 'production') {
    console.error(
      `[whatsapp] ATENCIÓN: WHATSAPP_ALLOWLIST está activa EN PRODUCCIÓN. ` +
        `El bot solo le responde a: ${numeros}. Al resto de clientes NO les contesta. ` +
        `Si esto no es deliberado, quita la variable y reinicia.`,
    );
  } else {
    console.warn(`[whatsapp] lista blanca activa — el bot solo responde a: ${numeros}`);
  }
}
