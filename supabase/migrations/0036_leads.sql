-- 0036_leads.sql · Leads de la campaña de pre-registro (landing /pre-registro)
--
-- Los inserta el backend con service_role vía POST /api/leads. El navegador NUNCA
-- escribe directo a esta tabla. RLS habilitada SIN políticas públicas: el único
-- acceso es server-side con service_role (que bypasea RLS). Así los leads quedan
-- privados (no son legibles por anon/usuarios).

create table if not exists public.leads (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  whatsapp        text,
  business_name   text,
  contact_name    text,
  phone           text,
  email           text,
  contact_channel text,          -- whatsapp | llamada | email
  plan            text,          -- cohorte/oferta, p.ej. 'negocio_regalo'
  orders_volume   text,          -- ej. '30-60', '+100', 'apenas-arranco'
  peak_hours      text,          -- ej. 'almuerzo, noche'
  est_loss        text,          -- ej. '1M-3M', 'no-se'
  city            text,          -- ciudad del restaurante
  current_apps    text,          -- ej. 'Rappi, DiDi Food' | 'Ninguna'
  cuisine_type    text,          -- ej. 'Hamburguesas', 'Comida típica'
  estado          text,          -- 'parcial' | 'calificado'
  source          text default 'landing-preregistro',
  user_agent      text
);

-- RLS on, sin policies: solo service_role (backend) lee/escribe.
alter table public.leads enable row level security;

create index if not exists leads_created_at_idx on public.leads (created_at desc);
create index if not exists leads_whatsapp_idx on public.leads (whatsapp);
