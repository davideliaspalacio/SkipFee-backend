/**
 * URL base para que el backend se llame a sí mismo (self-fetch interno).
 *
 * En contenedores (Railway, Render, etc.) NO se puede hacer `fetch` al propio
 * dominio público desde adentro del contenedor: el "loopback" falla y la
 * respuesta vuelve vacía (causa el clásico `Unexpected end of JSON input`).
 * Por eso las llamadas internas (bot → /api/checkout/sessions, bot → /api/orders)
 * van por el puerto local. `PORT` lo setea la plataforma (Railway usa 8080);
 * en desarrollo cae a 3000.
 *
 * OJO: esto es SOLO para llamadas internas del backend a sí mismo. Para URLs
 * que ve el cliente (links de pago, etc.) se sigue usando NEXT_PUBLIC_APP_ORIGIN.
 */
export function internalApiOrigin(): string {
  return `http://127.0.0.1:${process.env.PORT ?? '3000'}`;
}
