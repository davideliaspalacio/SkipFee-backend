/**
 * Utilidades para tests de los route handlers de checkout.
 *
 * `makeSupabaseStub` arma un cliente Supabase falso, chainable, configurado por
 * tabla. Cada tabla declara:
 *  - `rows`: filas que devuelven los SELECT (filtradas por los .eq()).
 *  - `single`/`maybeSingle`: la fila que devuelve el terminador correspondiente.
 *  - handlers opcionales para insert/update/upsert que capturan el payload.
 *
 * No intenta ser un Postgres real: solo cubre los caminos que ejercen los tests.
 * NO toca Supabase real.
 */

export interface TableConfig {
  /** Filas para SELECT (resultado de queries que NO terminan en single). */
  rows?: unknown[];
  /** Resultado para .single() / .maybeSingle(). Si es Error, se devuelve como error. */
  single?: unknown;
  /** Error a devolver en cualquier terminador de esta tabla. */
  error?: { message: string } | null;
  /** Captura de inserts. */
  onInsert?: (payload: unknown) => { data?: unknown; error?: { message: string } | null } | void;
  /** Captura de updates. Recibe (payload, filters). */
  onUpdate?: (
    payload: unknown,
    filters: Record<string, unknown>,
  ) => { data?: unknown; error?: { message: string } | null } | void;
  /** Captura de upserts. */
  onUpsert?: (payload: unknown) => { data?: unknown; error?: { message: string } | null } | void;
  /** Captura de deletes. */
  onDelete?: (
    filters: Record<string, unknown>,
  ) => { data?: unknown; error?: { message: string } | null } | void;
}

export type SupabaseStubConfig = Record<string, TableConfig>;

export function makeSupabaseStub(config: SupabaseStubConfig) {
  const calls: Array<{ table: string; op: string; payload?: unknown; filters?: Record<string, unknown> }> = [];

  function from(table: string) {
    const cfg = config[table] ?? {};
    const filters: Record<string, unknown> = {};
    let mode: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
    let writePayload: unknown;
    let writeResult: { data?: unknown; error?: { message: string } | null } | void;

    const builder: Record<string, unknown> = {};

    const chain = () => builder;

    builder.select = () => chain();
    builder.order = () => chain();
    // `.limit()` NO termina la query: en supabase-js sigue siendo chainable y el
    // builder es awaitable vía `.then`. Devolvemos el chain para soportar
    // `.limit().eq()` y `.neq().neq().order().limit()`.
    builder.limit = () => chain();
    builder.eq = (col: string, val: unknown) => {
      filters[col] = val;
      return chain();
    };
    builder.neq = (col: string, val: unknown) => {
      const key = `${col}__neq`;
      const list = (filters[key] as unknown[]) ?? [];
      list.push(val);
      filters[key] = list;
      return chain();
    };
    builder.gte = (col: string, val: unknown) => {
      filters[`${col}__gte`] = val;
      return chain();
    };
    builder.lt = (col: string, val: unknown) => {
      filters[`${col}__lt`] = val;
      return chain();
    };
    builder.in = (col: string, vals: unknown[]) => {
      filters[`${col}__in`] = vals;
      return chain();
    };
    builder.is = (col: string, val: unknown) => {
      filters[`${col}__is`] = val;
      return chain();
    };
    builder.or = (expr: string) => {
      // El stub no evalúa expresiones OR de PostgREST: solo guarda lo recibido
      // por si un test quiere assert sobre el shape. No filtra rows.
      filters['__or'] = expr;
      return chain();
    };

    builder.insert = (payload: unknown) => {
      mode = 'insert';
      writePayload = payload;
      calls.push({ table, op: 'insert', payload });
      writeResult = cfg.onInsert?.(payload);
      return chain();
    };
    builder.update = (payload: unknown) => {
      mode = 'update';
      writePayload = payload;
      calls.push({ table, op: 'update', payload, filters });
      // Capturamos inmediatamente para soportar el patrón con RETURNING:
      //   `.update(payload).eq(...).select(...).single()`
      // Sin esto el handler `onUpdate` solo se invocaba en el terminator
      // `.then` (await directo sin .select()/.single()).
      writeResult = cfg.onUpdate?.(payload, filters);
      return chain();
    };
    builder.upsert = (payload: unknown) => {
      mode = 'upsert';
      writePayload = payload;
      calls.push({ table, op: 'upsert', payload });
      writeResult = cfg.onUpsert?.(payload);
      return chain();
    };
    builder.delete = () => {
      mode = 'delete';
      calls.push({ table, op: 'delete', filters });
      return chain();
    };

    builder.single = () => {
      if (mode === 'insert' || mode === 'upsert' || mode === 'update') {
        // Patrones con RETURNING: `.{insert|upsert|update}(...).select(...).single()`.
        // Si `onInsert/Upsert/Update` devolvió `{data}`, eso se devuelve. Si
        // devolvió void/null, caemos a `cfg.single` como fallback (útil para
        // tests que no quieren custom-shape la respuesta).
        const r = writeResult ?? {};
        return Promise.resolve({ data: r.data ?? cfg.single ?? null, error: r.error ?? cfg.error ?? null });
      }
      // SELECT terminado en .single(): si la tabla declaró `single`, se usa tal cual
      // (incluido `single: null` explícito ⇒ no encontrada). Si solo declaró `rows`,
      // devolvemos la primera fila tras aplicar los .eq()/.in() — así soportamos el
      // patrón `.eq('id', x).single()` sobre un dataset declarado como `rows`.
      if (cfg.single !== undefined) {
        return Promise.resolve({ data: cfg.single, error: cfg.error ?? null });
      }
      const filtered = applyFilter(cfg.rows ?? [], filters);
      return Promise.resolve({ data: filtered[0] ?? null, error: cfg.error ?? null });
    };
    builder.maybeSingle = () => {
      if (cfg.single !== undefined) {
        return Promise.resolve({ data: cfg.single, error: cfg.error ?? null });
      }
      const filtered = applyFilter(cfg.rows ?? [], filters);
      return Promise.resolve({ data: filtered[0] ?? null, error: cfg.error ?? null });
    };

    // Terminadores tipo update/delete que se await-ean directamente (sin select/single).
    builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      let result: { data: unknown; error: { message: string } | null };
      if (mode === 'update') {
        // `onUpdate` ya fue llamado en `update()` y guardado en `writeResult`.
        // No re-llamamos para evitar capturas duplicadas en tests.
        const r = writeResult ?? {};
        result = { data: (r.data ?? null) as unknown, error: r.error ?? cfg.error ?? null };
      } else if (mode === 'delete') {
        const r = cfg.onDelete?.(filters) ?? {};
        result = { data: (r.data ?? null) as unknown, error: r.error ?? cfg.error ?? null };
      } else if (mode === 'insert') {
        const r = writeResult ?? {};
        result = { data: (r.data ?? null) as unknown, error: r.error ?? cfg.error ?? null };
      } else {
        result = { data: applyFilter(cfg.rows ?? [], filters), error: cfg.error ?? null };
      }
      return Promise.resolve(result).then(resolve, reject);
    };

    return builder;
  }

  return { client: { from } as unknown, calls };
}

/** Filtro mínimo: aplica .eq() y .in() sobre las filas declaradas. */
function applyFilter(rows: unknown[], filters: Record<string, unknown>): unknown[] {
  return rows.filter(row => {
    const r = row as Record<string, unknown>;
    for (const [key, val] of Object.entries(filters)) {
      if (key.endsWith('__neq')) {
        const col = key.slice(0, -5);
        if ((val as unknown[]).includes(r[col])) return false;
      } else if (key.endsWith('__in')) {
        const col = key.slice(0, -4);
        if (!(val as unknown[]).includes(r[col])) return false;
      } else if (key.endsWith('__gte') || key.endsWith('__lt')) {
        // ignorado para el filtrado de listas en estos tests
        continue;
      } else if (key.endsWith('__is')) {
        const col = key.slice(0, -4);
        if (r[col] !== val) return false;
      } else if (key === '__or') {
        continue;
      } else {
        if (r[key] !== val) return false;
      }
    }
    return true;
  });
}

import type { NextRequest } from 'next/server';

/**
 * Construye un Request JSON tipado como `NextRequest` para pasárselo a los route
 * handlers (que tipan su primer arg como NextRequest). Los handlers solo usan la
 * API base de `Request` (`.json()`, `.url`, `.headers`, `.formData()`), así que
 * un `Request` plano basta en runtime; el cast satisface a TypeScript sin montar
 * el runtime completo de Next.
 */
export function jsonRequest(url: string, method: string, body: unknown): NextRequest {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

/** Igual que `jsonRequest` pero para GET/sin body (la tienda al cargar). */
export function getRequest(url: string): NextRequest {
  return new Request(url) as unknown as NextRequest;
}

/** Construye el `{ params }` async que reciben los route handlers (Next 16). */
export function asyncParams<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}
