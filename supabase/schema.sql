-- =====================================================================
--  TALLERES CREATIVOS · v1.0.0
--  Script para crear las tablas en Supabase.
--
--  CÓMO USARLO:
--  1. Entra a tu proyecto en https://app.supabase.com
--  2. Ve a "SQL Editor" -> "New query"
--  3. Pega TODO este archivo y presiona "Run"
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tabla: materials (Inventario)
-- ---------------------------------------------------------------------
create table if not exists public.materials (
  id         uuid primary key default gen_random_uuid(),
  nombre     text not null,
  categoria  text not null default 'Otros',
  unidad     text not null default 'pieza',
  cant_adq   numeric not null default 0,
  costo_adq  numeric not null default 0,
  existencia numeric not null default 0,
  minimo     numeric not null default 0,
  margen     numeric not null default 100,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Tabla: workshop_types (Tipos de taller)
-- ---------------------------------------------------------------------
create table if not exists public.workshop_types (
  id            uuid primary key default gen_random_uuid(),
  nombre        text not null,
  duracion      numeric not null default 1,
  margen        numeric not null default 50,
  precio_final  numeric not null default 0,
  incluye_cafe  boolean not null default false,
  materiales    jsonb not null default '[]'::jsonb,  -- [{material_id, cantidad}]
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Tabla: combos (Juegos / combos)
-- ---------------------------------------------------------------------
create table if not exists public.combos (
  id            uuid primary key default gen_random_uuid(),
  nombre        text not null,
  margen        numeric not null default 100,
  precio_final  numeric not null default 0,
  materiales    jsonb not null default '[]'::jsonb,  -- [{material_id, cantidad}]
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Tabla: sessions (Talleres realizados)
-- ---------------------------------------------------------------------
create table if not exists public.sessions (
  id            uuid primary key default gen_random_uuid(),
  fecha         date not null default current_date,
  tipo_id       uuid,
  tipo_nombre   text not null,
  personas      integer not null default 1,
  total_taller  numeric not null default 0,
  total_cafe    numeric not null default 0,
  cafe_negocio  numeric not null default 0,
  costo_mat     numeric not null default 0,
  utilidad      numeric not null default 0,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Tabla: sales (Ventas sueltas de materiales o combos)
-- ---------------------------------------------------------------------
create table if not exists public.sales (
  id             uuid primary key default gen_random_uuid(),
  fecha          date not null default current_date,
  tipo           text not null default 'material',
  referencia_id  uuid,
  nombre         text not null,
  cantidad       numeric not null default 1,
  precio         numeric not null default 0,
  total          numeric not null default 0,
  costo          numeric not null default 0,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Tabla: settings (un solo renglón "main" con configuración general)
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  id          text primary key default 'main',
  cafe_precio numeric not null default 59
);

insert into public.settings (id, cafe_precio) values ('main', 59)
on conflict (id) do nothing;

-- =====================================================================
-- SEGURIDAD (RLS): solo usuarios que iniciaron sesión pueden leer
-- o modificar información. Sin sesión, no se puede hacer nada.
-- =====================================================================
alter table public.materials      enable row level security;
alter table public.workshop_types enable row level security;
alter table public.combos         enable row level security;
alter table public.sessions       enable row level security;
alter table public.sales          enable row level security;
alter table public.settings       enable row level security;

drop policy if exists "solo_autenticados" on public.materials;
drop policy if exists "solo_autenticados" on public.workshop_types;
drop policy if exists "solo_autenticados" on public.combos;
drop policy if exists "solo_autenticados" on public.sessions;
drop policy if exists "solo_autenticados" on public.sales;
drop policy if exists "solo_autenticados" on public.settings;

create policy "solo_autenticados" on public.materials
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "solo_autenticados" on public.workshop_types
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "solo_autenticados" on public.combos
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "solo_autenticados" on public.sessions
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "solo_autenticados" on public.sales
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "solo_autenticados" on public.settings
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.materials, public.workshop_types, public.combos,
  public.sessions, public.sales, public.settings
  to authenticated;

-- =====================================================================
-- DATOS INICIALES (opcional, puedes editarlos o borrarlos después)
-- =====================================================================
insert into public.materials (nombre, categoria, unidad, cant_adq, costo_adq, existencia, minimo, margen)
select * from (values
  ('Tote Bag',        'Piezas',   'pieza', 1,   30,  9, 3, 100),
  ('Pintura blanca',  'Pinturas', 'ml',    750, 195, 750, 60, 150),
  ('Pintura negra',   'Pinturas', 'ml',    300, 150, 300, 30, 150),
  ('Pintura roja',    'Pinturas', 'ml',    300, 150, 300, 30, 150),
  ('Pintura verde',   'Pinturas', 'ml',    300, 150, 300, 30, 150),
  ('Pintura azul',    'Pinturas', 'ml',    300, 150, 300, 30, 150),
  ('Pintura amarilla','Pinturas', 'ml',    300, 150, 300, 30, 150)
) as v(nombre, categoria, unidad, cant_adq, costo_adq, existencia, minimo, margen)
where not exists (select 1 from public.materials m where m.nombre = v.nombre);

-- ================================ FIN ================================
