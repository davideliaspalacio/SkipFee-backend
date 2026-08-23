// Módulo presencial (dine-in) · tipos + serialización compartida.
// La BD usa snake_case; la API responde camelCase (misma frontera que
// lib/serializers.ts). Estos helpers los consumen las rutas de mesas y meseros.

export const TABLE_SELECT =
  'id, code, label, area, seats, qr_token, is_active, archived, created_at';
export const WAITER_SELECT = 'id, name, phone, archived, created_at';

export interface DiningTableRow {
  id: string;
  code: string;
  label: string | null;
  area: string | null;
  seats: number;
  qr_token: string;
  is_active: boolean;
  archived: boolean;
  created_at: string;
}

export interface DiningTable {
  id: string;
  code: string;
  label: string | null;
  area: string | null;
  seats: number;
  qrToken: string;
  isActive: boolean;
  archived: boolean;
  createdAt: string;
}

export function serializeTable(row: DiningTableRow): DiningTable {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    area: row.area,
    seats: row.seats,
    qrToken: row.qr_token,
    isActive: row.is_active,
    archived: row.archived,
    createdAt: row.created_at,
  };
}

export interface WaiterRow {
  id: string;
  name: string;
  phone: string | null;
  archived: boolean;
  created_at: string;
}

export interface Waiter {
  id: string;
  name: string;
  phone: string | null;
  archived: boolean;
  createdAt: string;
}

export function serializeWaiter(row: WaiterRow): Waiter {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    archived: row.archived,
    createdAt: row.created_at,
  };
}
