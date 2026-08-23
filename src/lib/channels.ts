import type { SupabaseClient } from '@supabase/supabase-js';

export type ChannelProvider = 'whatsapp' | 'storefront' | 'rappi' | 'didi' | 'ubereats' | 'manual' | 'presencial';
export type MarketplaceProvider = 'rappi' | 'didi';
export type ChannelKind = 'direct' | 'marketplace' | 'pos';
export type ChannelMode = 'none' | 'simulated' | 'live';
export type ChannelStatus =
  | 'not_configured'
  | 'simulated_ready'
  | 'live_pending_credentials'
  | 'live_connected'
  | 'degraded'
  | 'paused';

export type OrderStatus = 'nuevo' | 'pagado' | 'cocina' | 'empacado' | 'ruta' | 'entregado';

interface ChannelSeed {
  provider: ChannelProvider;
  name: string;
  kind: ChannelKind;
  mode: ChannelMode;
  status: ChannelStatus;
  deliveryMode: string;
  commissionRateBps: number;
  credentialsStatus: string;
  settings: Record<string, unknown>;
}

interface SalesChannelRow {
  id: string;
  company_id: string;
  provider: ChannelProvider;
  name: string;
  kind: ChannelKind;
  mode: ChannelMode;
  status: ChannelStatus;
  delivery_mode: string;
  commission_rate_bps: number;
  external_store_id: string | null;
  credentials_status: string;
  settings: Record<string, unknown> | null;
  last_event_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface ChannelOrderRow {
  id: string;
  total: number | null;
  status: string;
  sales_channel: string | null;
  channel_commission: number | null;
  created_at: string;
}

interface ProductRow {
  id: string;
  name: string;
  price: number;
  available: boolean;
}

interface ZoneRow {
  id: string;
  name: string;
  tarifa: number;
  lat: number;
  lng: number;
}

const DEFAULT_CHANNELS: ChannelSeed[] = [
  {
    provider: 'whatsapp',
    name: 'WhatsApp',
    kind: 'direct',
    mode: 'live',
    status: 'live_connected',
    deliveryMode: 'own_delivery',
    commissionRateBps: 0,
    credentialsStatus: 'configured',
    settings: { adapter: 'kapso' },
  },
  {
    provider: 'storefront',
    name: 'Tienda directa',
    kind: 'direct',
    mode: 'live',
    status: 'live_connected',
    deliveryMode: 'own_delivery',
    commissionRateBps: 0,
    credentialsStatus: 'configured',
    settings: { adapter: 'skipfee_checkout' },
  },
  {
    provider: 'rappi',
    name: 'Rappi',
    kind: 'marketplace',
    mode: 'simulated',
    status: 'simulated_ready',
    deliveryMode: 'provider_or_own',
    commissionRateBps: 2600,
    credentialsStatus: 'missing',
    settings: { docs: 'https://dev-portal.rappi.com/' },
  },
  {
    provider: 'didi',
    name: 'DiDi Food',
    kind: 'marketplace',
    mode: 'simulated',
    status: 'simulated_ready',
    deliveryMode: 'provider_or_own',
    commissionRateBps: 2400,
    credentialsStatus: 'missing',
    settings: { docs: 'https://developer.didi-food.com/' },
  },
  {
    provider: 'ubereats',
    name: 'Uber Eats',
    kind: 'marketplace',
    mode: 'none',
    status: 'live_pending_credentials',
    deliveryMode: 'provider_or_own',
    commissionRateBps: 2800,
    credentialsStatus: 'missing',
    settings: { blocked: 'Sin credenciales en esta fase' },
  },
  {
    provider: 'manual',
    name: 'POS manual',
    kind: 'pos',
    mode: 'none',
    status: 'not_configured',
    deliveryMode: 'pickup_or_table',
    commissionRateBps: 0,
    credentialsStatus: 'missing',
    settings: {},
  },
  {
    provider: 'presencial',
    name: 'Presencial / Mesa',
    kind: 'pos',
    mode: 'live',
    status: 'live_connected',
    deliveryMode: 'dine_in',
    commissionRateBps: 0,
    credentialsStatus: 'configured',
    settings: {
      split: { minShare: 15000, maxParts: 10, feeOwner: 'restaurante', fixedSurcharge: 0 },
      dineIn: { selfOrderQR: true },
    },
  },
];

const REQUIREMENTS = [
  {
    area: 'Documentación',
    item: 'Contrato real de endpoints, payloads y estados por país',
    state: 'Rappi público / DiDi privado pendiente',
    priority: 'Alta',
  },
  {
    area: 'Credenciales',
    item: 'client_id, client_secret, store IDs y webhook secret',
    state: 'Pendiente live',
    priority: 'Alta',
  },
  {
    area: 'Webhooks',
    item: 'Recepción, firma, deduplicación e idempotencia',
    state: 'Base lista',
    priority: 'Alta',
  },
  {
    area: 'Pedidos',
    item: 'Origen, ID externo, entrega y estado externo',
    state: 'Base lista',
    priority: 'Alta',
  },
  {
    area: 'Catálogo',
    item: 'Mapeo producto interno contra producto externo',
    state: 'Base lista',
    priority: 'Media',
  },
  {
    area: 'Reportes',
    item: 'Ventas, descuentos y comisiones por canal',
    state: 'Base lista',
    priority: 'Media',
  },
];

const FAKE_CUSTOMERS = [
  { name: 'Camila Restrepo', phone: '573001110201', address: 'Cra. 35 #8-71' },
  { name: 'Andres Ochoa', phone: '573001110202', address: 'Cl. 10 #43A-12' },
  { name: 'Laura Mejia', phone: '573001110203', address: 'Cra. 80 #44-21' },
  { name: 'Mateo Salazar', phone: '573001110204', address: 'Cl. 33 #74-12' },
  { name: 'Valentina Ruiz', phone: '573001110205', address: 'Transversal 39B #76-18' },
];

const RappiStatuses = ['READY', 'SENT', 'TAKEN'] as const;
const DidiStatuses = ['ORDER_CREATED', 'ORDER_ACCEPTED', 'IN_PREPARATION'] as const;

interface MarketplaceStatusSyncInput {
  sb: SupabaseClient;
  companyId: string;
  orderId: string;
  provider: MarketplaceProvider;
  externalOrderId: string | null;
  fromStatus: OrderStatus;
  toStatus: OrderStatus;
}

interface MarketplaceStatusMapping {
  action: string;
  externalStatus: string;
  shouldCallProvider: boolean;
}

function dbRows<T>(data: unknown[] | null): T[] {
  return (data ?? []) as T[];
}

function nowIso() {
  return new Date().toISOString();
}

function startOfTodayBogota(): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find(p => p.type === 'year')?.value;
  const month = parts.find(p => p.type === 'month')?.value;
  const day = parts.find(p => p.type === 'day')?.value;
  return new Date(`${year}-${month}-${day}T05:00:00.000Z`);
}

function minutesAgo(iso: string | null): string {
  if (!iso) return 'Sin eventos';
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return 'Ahora';
  if (minutes < 60) return `Hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Hace ${hours} h`;
  return `Hace ${Math.floor(hours / 24)} d`;
}

function displayStatus(status: ChannelStatus): string {
  if (status === 'live_connected') return 'Conectado';
  if (status === 'simulated_ready') return 'Simulador activo';
  if (status === 'live_pending_credentials') return 'Pendiente credenciales';
  if (status === 'degraded') return 'Con errores';
  if (status === 'paused') return 'Pausado';
  return 'No configurado';
}

function deliveryLabel(mode: string): string {
  if (mode === 'own_delivery') return 'Entrega propia';
  if (mode === 'provider_or_own') return 'Marketplace / propia';
  if (mode === 'pickup_or_table') return 'Recogida / mesa';
  if (mode === 'dine_in') return 'En mesa';
  return mode;
}

function providerName(provider: MarketplaceProvider): string {
  return provider === 'rappi' ? 'Rappi' : 'DiDi Food';
}

function providerExternalStatus(provider: MarketplaceProvider): string {
  if (provider === 'rappi') return RappiStatuses[Math.floor(Math.random() * RappiStatuses.length)];
  return DidiStatuses[Math.floor(Math.random() * DidiStatuses.length)];
}

function providerDeliveryMethod(provider: MarketplaceProvider): string {
  if (provider === 'rappi') {
    const methods = ['delivery', 'marketplace', 'pickup'];
    return methods[Math.floor(Math.random() * methods.length)];
  }
  return 'delivery';
}

function randomPick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export function isMarketplaceProvider(provider: string | null | undefined): provider is MarketplaceProvider {
  return provider === 'rappi' || provider === 'didi';
}

function mapSkipfeeStatusToMarketplace(
  provider: MarketplaceProvider,
  status: OrderStatus,
): MarketplaceStatusMapping {
  if (provider === 'rappi') {
    if (status === 'pagado' || status === 'cocina') {
      return { action: 'take_order', externalStatus: 'TAKEN', shouldCallProvider: true };
    }
    if (status === 'empacado') {
      return { action: 'ready_for_pickup', externalStatus: 'READY_FOR_PICKUP', shouldCallProvider: true };
    }
    if (status === 'ruta') {
      return { action: 'dispatch_started', externalStatus: 'TAKEN', shouldCallProvider: false };
    }
    if (status === 'entregado') {
      return { action: 'completed_locally', externalStatus: 'DELIVERED', shouldCallProvider: false };
    }
    return { action: 'local_status', externalStatus: 'SENT', shouldCallProvider: false };
  }

  if (status === 'pagado') {
    return { action: 'accept_order', externalStatus: 'ORDER_ACCEPTED', shouldCallProvider: true };
  }
  if (status === 'cocina') {
    return { action: 'start_preparing', externalStatus: 'IN_PREPARATION', shouldCallProvider: true };
  }
  if (status === 'empacado') {
    return { action: 'ready_for_pickup', externalStatus: 'READY_FOR_PICKUP', shouldCallProvider: true };
  }
  if (status === 'ruta') {
    return { action: 'dispatch_started', externalStatus: 'ON_THE_WAY', shouldCallProvider: true };
  }
  if (status === 'entregado') {
    return { action: 'complete_order', externalStatus: 'COMPLETED', shouldCallProvider: true };
  }
  return { action: 'local_status', externalStatus: 'ORDER_CREATED', shouldCallProvider: false };
}

async function recordMarketplaceStatusEvent(
  sb: SupabaseClient,
  input: MarketplaceStatusSyncInput,
  channelId: string | null,
  mapping: MarketplaceStatusMapping,
  status: 'processed' | 'failed' | 'ignored',
  payload: Record<string, unknown>,
  error?: string,
) {
  const eventId = `${input.orderId}:${input.toStatus}:${mapping.action}:${Date.now()}`;
  await sb.from('marketplace_events').insert({
    company_id: input.companyId,
    channel_id: channelId,
    provider: input.provider,
    external_event_id: eventId,
    event_type: `order.status.${mapping.action}`,
    external_order_id: input.externalOrderId,
    payload,
    status,
    processed_order_id: input.orderId,
    error: error ?? null,
    processed_at: nowIso(),
  });
}

async function callLiveMarketplaceStatusAdapter(
  provider: MarketplaceProvider,
  _mapping: MarketplaceStatusMapping,
  _input: MarketplaceStatusSyncInput,
  _settings: Record<string, unknown>,
): Promise<{ ok: true; externalStatus?: string; response?: Record<string, unknown> } | { ok: false; error: string }> {
  return {
    ok: false,
    error:
      provider === 'rappi'
        ? 'Adapter live de Rappi pendiente de credenciales client_id/client_secret/store_id'
        : 'Adapter live de DiDi pendiente de documentación privada y credenciales',
  };
}

function normalizeChannelSeed(companyId: string, seed: ChannelSeed) {
  return {
    company_id: companyId,
    provider: seed.provider,
    name: seed.name,
    kind: seed.kind,
    mode: seed.mode,
    status: seed.status,
    delivery_mode: seed.deliveryMode,
    commission_rate_bps: seed.commissionRateBps,
    credentials_status: seed.credentialsStatus,
    settings: seed.settings,
  };
}

export async function ensureDefaultChannels(sb: SupabaseClient, companyId: string) {
  const payload = DEFAULT_CHANNELS.map(seed => normalizeChannelSeed(companyId, seed));
  const { error } = await sb
    .from('sales_channels')
    .upsert(payload, { onConflict: 'company_id,provider', ignoreDuplicates: true });
  if (error) throw error;
}

export async function listChannelsOverview(sb: SupabaseClient, companyId: string) {
  await ensureDefaultChannels(sb, companyId);

  const todayStart = startOfTodayBogota().toISOString();
  const [{ data: channelData, error: channelError }, { data: orderData, error: orderError }] =
    await Promise.all([
      sb
        .from('sales_channels')
        .select(
          'id, company_id, provider, name, kind, mode, status, delivery_mode, commission_rate_bps, external_store_id, credentials_status, settings, last_event_at, last_error, created_at, updated_at',
        )
        .eq('company_id', companyId)
        .order('kind')
        .order('name'),
      sb
        .from('orders')
        .select('id, total, status, sales_channel, channel_commission, created_at')
        .eq('company_id', companyId)
        .gte('created_at', todayStart)
        .not('status', 'eq', 'expirado'),
    ]);

  if (channelError) throw channelError;
  if (orderError) throw orderError;

  const orders = dbRows<ChannelOrderRow>(orderData);
  const metrics = new Map<string, { ordersToday: number; salesToday: number; commissionToday: number }>();
  for (const order of orders) {
    if (order.status === 'borrador') continue;
    const provider = order.sales_channel ?? 'whatsapp';
    const current = metrics.get(provider) ?? { ordersToday: 0, salesToday: 0, commissionToday: 0 };
    current.ordersToday += 1;
    current.salesToday += order.total ?? 0;
    current.commissionToday += order.channel_commission ?? 0;
    metrics.set(provider, current);
  }

  const channels = dbRows<SalesChannelRow>(channelData).map(channel => {
    const m = metrics.get(channel.provider) ?? {
      ordersToday: 0,
      salesToday: 0,
      commissionToday: 0,
    };
    return {
      id: channel.id,
      provider: channel.provider,
      name: channel.name,
      kind: channel.kind,
      mode: channel.mode,
      status: channel.status,
      statusLabel: displayStatus(channel.status),
      deliveryMode: channel.delivery_mode,
      deliveryLabel: deliveryLabel(channel.delivery_mode),
      commissionRateBps: channel.commission_rate_bps,
      externalStoreId: channel.external_store_id,
      credentialsStatus: channel.credentials_status,
      ordersToday: m.ordersToday,
      salesToday: m.salesToday,
      commissionToday: m.commissionToday,
      lastEventAt: channel.last_event_at,
      lastEventLabel: minutesAgo(channel.last_event_at),
      lastError: channel.last_error,
      settings: channel.settings ?? {},
    };
  });

  const totalOrders = channels.reduce((sum, c) => sum + c.ordersToday, 0);
  const totalSales = channels.reduce((sum, c) => sum + c.salesToday, 0);
  const directSales = channels
    .filter(c => c.kind === 'direct')
    .reduce((sum, c) => sum + c.salesToday, 0);
  const marketplaceSales = channels
    .filter(c => c.kind === 'marketplace')
    .reduce((sum, c) => sum + c.salesToday, 0);
  const commissionToday = channels.reduce((sum, c) => sum + c.commissionToday, 0);
  const avoidedCommission = Math.round(directSales * 0.26);

  return {
    channels,
    summary: {
      activeChannels: channels.filter(c => c.status === 'live_connected' || c.status === 'simulated_ready').length,
      totalOrders,
      totalSales,
      directSales,
      marketplaceSales,
      commissionToday,
      avoidedCommission,
    },
    requirements: REQUIREMENTS,
  };
}

export async function setChannelAction(
  sb: SupabaseClient,
  companyId: string,
  provider: ChannelProvider,
  action: 'enable_simulator' | 'prepare_live' | 'pause' | 'resume',
) {
  await ensureDefaultChannels(sb, companyId);

  const patch =
    action === 'enable_simulator'
      ? { mode: 'simulated', status: 'simulated_ready', last_error: null }
      : action === 'prepare_live'
        ? { mode: 'none', status: 'live_pending_credentials', last_error: null }
        : action === 'pause'
          ? { status: 'paused' }
          : { status: provider === 'rappi' || provider === 'didi' ? 'simulated_ready' : 'not_configured' };

  const { data, error } = await sb
    .from('sales_channels')
    .update(patch)
    .eq('company_id', companyId)
    .eq('provider', provider)
    .select('provider, status, mode')
    .single();

  if (error) throw error;
  return data;
}

export async function syncMarketplaceOrderStatus(input: MarketplaceStatusSyncInput): Promise<
  | {
      ok: true;
      mode: ChannelMode;
      provider: MarketplaceProvider;
      action: string;
      externalStatus: string;
      simulated: boolean;
    }
  | {
      ok: false;
      mode: ChannelMode | null;
      provider: MarketplaceProvider;
      action: string;
      error: string;
      skipped?: boolean;
    }
> {
  const { sb, companyId, provider, orderId, externalOrderId } = input;
  const mapping = mapSkipfeeStatusToMarketplace(provider, input.toStatus);

  if (!externalOrderId) {
    return {
      ok: false,
      mode: null,
      provider,
      action: mapping.action,
      error: 'Pedido sin external_order_id; no se puede sincronizar con marketplace',
      skipped: true,
    };
  }

  await ensureDefaultChannels(sb, companyId);

  const { data: channelData, error: channelError } = await sb
    .from('sales_channels')
    .select('id, provider, mode, status, settings')
    .eq('company_id', companyId)
    .eq('provider', provider)
    .maybeSingle();

  if (channelError || !channelData) {
    return {
      ok: false,
      mode: null,
      provider,
      action: mapping.action,
      error: channelError?.message ?? 'Canal marketplace no encontrado',
      skipped: true,
    };
  }

  const channel = channelData as {
    id: string;
    provider: MarketplaceProvider;
    mode: ChannelMode;
    status: ChannelStatus;
    settings: Record<string, unknown> | null;
  };

  if (channel.status === 'paused' || channel.mode === 'none') {
    await recordMarketplaceStatusEvent(
      sb,
      input,
      channel.id,
      mapping,
      'ignored',
      {
        skipped: true,
        reason: channel.status === 'paused' ? 'channel_paused' : 'channel_not_configured',
        provider,
        externalOrderId,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        mapping,
      },
    );
    return {
      ok: false,
      mode: channel.mode,
      provider,
      action: mapping.action,
      error: channel.status === 'paused' ? 'Canal pausado' : 'Canal no configurado',
      skipped: true,
    };
  }

  if (channel.mode === 'simulated') {
    await recordMarketplaceStatusEvent(
      sb,
      input,
      channel.id,
      mapping,
      'processed',
      {
        simulated: true,
        provider,
        externalOrderId,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        action: mapping.action,
        externalStatus: mapping.externalStatus,
        shouldCallProvider: mapping.shouldCallProvider,
      },
    );

    await Promise.all([
      sb
        .from('orders')
        .update({ channel_status: mapping.externalStatus })
        .eq('company_id', companyId)
        .eq('id', orderId),
      sb
        .from('sales_channels')
        .update({ last_event_at: nowIso(), last_error: null })
        .eq('company_id', companyId)
        .eq('provider', provider),
    ]);

    return {
      ok: true,
      mode: channel.mode,
      provider,
      action: mapping.action,
      externalStatus: mapping.externalStatus,
      simulated: true,
    };
  }

  const liveResult = await callLiveMarketplaceStatusAdapter(
    provider,
    mapping,
    input,
    channel.settings ?? {},
  );

  if (!liveResult.ok) {
    await recordMarketplaceStatusEvent(
      sb,
      input,
      channel.id,
      mapping,
      'failed',
      {
        simulated: false,
        provider,
        externalOrderId,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        action: mapping.action,
        externalStatus: mapping.externalStatus,
      },
      liveResult.error,
    );
    await sb
      .from('sales_channels')
      .update({ status: 'degraded', last_error: liveResult.error, last_event_at: nowIso() })
      .eq('company_id', companyId)
      .eq('provider', provider);

    return {
      ok: false,
      mode: channel.mode,
      provider,
      action: mapping.action,
      error: liveResult.error,
    };
  }

  const externalStatus = liveResult.externalStatus ?? mapping.externalStatus;
  await recordMarketplaceStatusEvent(
    sb,
    input,
    channel.id,
    mapping,
    'processed',
    {
      simulated: false,
      provider,
      externalOrderId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      action: mapping.action,
      externalStatus,
      response: liveResult.response ?? {},
    },
  );
  await Promise.all([
    sb
      .from('orders')
      .update({ channel_status: externalStatus })
      .eq('company_id', companyId)
      .eq('id', orderId),
    sb
      .from('sales_channels')
      .update({ status: 'live_connected', last_error: null, last_event_at: nowIso() })
      .eq('company_id', companyId)
      .eq('provider', provider),
  ]);

  return {
    ok: true,
    mode: channel.mode,
    provider,
    action: mapping.action,
    externalStatus,
    simulated: false,
  };
}

export async function simulateMarketplaceOrder(
  sb: SupabaseClient,
  companyId: string,
  provider: MarketplaceProvider,
) {
  await ensureDefaultChannels(sb, companyId);

  const { data: channelData, error: channelError } = await sb
    .from('sales_channels')
    .select('id, provider, name, status, mode, commission_rate_bps, external_store_id')
    .eq('company_id', companyId)
    .eq('provider', provider)
    .single();
  if (channelError || !channelData) throw channelError ?? new Error('Canal no encontrado');

  const channel = channelData as {
    id: string;
    provider: MarketplaceProvider;
    name: string;
    status: ChannelStatus;
    mode: ChannelMode;
    commission_rate_bps: number;
    external_store_id: string | null;
  };

  if (channel.status !== 'simulated_ready') {
    throw new Error('El simulador de este canal no está activo');
  }

  const [{ data: productData, error: productError }, { data: zoneData, error: zoneError }] =
    await Promise.all([
      sb
        .from('products')
        .select('id, name, price, available')
        .eq('company_id', companyId)
        .eq('available', true)
        .eq('archived', false)
        .limit(24),
      sb
        .from('zones')
        .select('id, name, tarifa, lat, lng')
        .eq('company_id', companyId)
        .eq('archived', false)
        .limit(24),
    ]);

  if (productError) throw productError;
  if (zoneError) throw zoneError;

  const products = dbRows<ProductRow>(productData);
  const zones = dbRows<ZoneRow>(zoneData);
  if (products.length === 0) throw new Error('No hay productos disponibles para simular');
  if (zones.length === 0) throw new Error('No hay zonas activas para simular');

  const selectedProducts = Array.from({ length: Math.min(products.length, 2 + Math.floor(Math.random() * 2)) })
    .map(() => randomPick(products))
    .filter((p, index, arr) => arr.findIndex(x => x.id === p.id) === index);
  const zone = randomPick(zones);
  const fakeCustomer = randomPick(FAKE_CUSTOMERS);
  const suffix = String(Math.floor(1000 + Math.random() * 9000));
  const phone = `${fakeCustomer.phone.slice(0, -4)}${suffix}`;
  const externalOrderId = `${provider.toUpperCase()}-${Date.now()}-${suffix}`;
  const externalEventId = `${externalOrderId}-created`;
  const externalStatus = providerExternalStatus(provider);
  const deliveryMethod = providerDeliveryMethod(provider);

  let subtotal = 0;
  const itemsToInsert = selectedProducts.map(product => {
    const qty = 1 + Math.floor(Math.random() * 2);
    subtotal += product.price * qty;
    return {
      product_id: product.id,
      qty,
      price_at_order: product.price,
      company_id: companyId,
    };
  });

  const delivery = deliveryMethod === 'pickup' ? 0 : zone.tarifa;
  const discount = provider === 'rappi' ? 2000 : 1500;
  const total = Math.max(0, subtotal + delivery - discount);
  const commission = Math.round(subtotal * (channel.commission_rate_bps / 10_000));

  const payload = {
    simulated: true,
    provider,
    externalOrderId,
    externalStatus,
    externalStoreId: channel.external_store_id ?? `demo-${provider}-store`,
    deliveryMethod,
    totals: {
      subtotal,
      delivery,
      discount,
      total,
      commission,
    },
    customer: {
      name: fakeCustomer.name,
      phone,
      address: `${fakeCustomer.address}, ${zone.name}`,
    },
    items: itemsToInsert.map((item, index) => ({
      externalProductId: `${provider}-sku-${selectedProducts[index].id}`,
      productId: item.product_id,
      qty: item.qty,
      price: item.price_at_order,
    })),
  };

  const { data: customer, error: customerError } = await sb
    .from('customers')
    .upsert(
      {
        company_id: companyId,
        name: fakeCustomer.name,
        phone,
        addr: `${fakeCustomer.address}, ${zone.name}`,
        zone_id: zone.id,
        tag: 'Nuevo',
      },
      { onConflict: 'company_id,phone' },
    )
    .select('id')
    .single();
  if (customerError || !customer) throw customerError ?? new Error('No se pudo crear cliente');

  const { data: order, error: orderError } = await sb
    .from('orders')
    .insert({
      company_id: companyId,
      customer_id: (customer as { id: string }).id,
      total,
      zone_id: zone.id,
      status: 'pagado',
      address: `${fakeCustomer.address}, ${zone.name}`,
      phone,
      payment_method: `${providerName(provider)} · Simulado`,
      note: `Pedido simulado desde ${providerName(provider)} (${externalStatus})`,
      lat: zone.lat + (Math.random() - 0.5) * 0.01,
      lng: zone.lng + (Math.random() - 0.5) * 0.01,
      sales_channel: provider,
      external_order_id: externalOrderId,
      external_store_id: channel.external_store_id ?? `demo-${provider}-store`,
      channel_status: externalStatus,
      channel_delivery_method: deliveryMethod,
      channel_commission: commission,
      channel_discount: discount,
      channel_payload: payload,
    })
    .select('id, order_number')
    .single();
  if (orderError || !order) throw orderError ?? new Error('No se pudo crear pedido');

  const orderId = (order as { id: string }).id;
  const itemsWithOrderId = itemsToInsert.map(item => ({ ...item, order_id: orderId }));
  const { error: itemsError } = await sb.from('order_items').insert(itemsWithOrderId);
  if (itemsError) throw itemsError;

  const { data: eventData, error: eventError } = await sb
    .from('marketplace_events')
    .insert({
      company_id: companyId,
      channel_id: channel.id,
      provider,
      external_event_id: externalEventId,
      event_type: 'order.created',
      external_order_id: externalOrderId,
      payload,
      status: 'processed',
      processed_order_id: orderId,
      processed_at: nowIso(),
    })
    .select('id')
    .single();
  if (eventError) throw eventError;

  await sb
    .from('sales_channels')
    .update({ last_event_at: nowIso(), last_error: null })
    .eq('company_id', companyId)
    .eq('provider', provider);

  return {
    provider,
    externalOrderId,
    eventId: (eventData as { id: string }).id,
    orderId,
    orderNumber: (order as { order_number: number | null }).order_number,
    total,
    commission,
    discount,
  };
}
