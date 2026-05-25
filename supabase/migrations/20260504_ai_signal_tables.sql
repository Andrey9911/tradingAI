-- Таблицы для AI-анализа пересланных сигналов (Supabase / Postgres)

create table if not exists public.telegram_signal_posts (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  source_type text not null,
  source_title text,
  source_chat_id bigint,
  source_message_id bigint,
  source_posted_at timestamptz,
  raw_text text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.trade_signals (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  raw_post_id uuid references public.telegram_signal_posts (id) on delete set null,
  source_title text,
  symbol text not null,
  side text not null,
  market_type text not null,
  entry_type text not null,
  entry_min double precision,
  entry_max double precision,
  entry_levels jsonb not null default '[]'::jsonb,
  take_profits jsonb not null default '[]'::jsonb,
  stop_loss double precision,
  leverage double precision,
  timeframe text,
  current_price double precision,
  entry_status text not null,
  entry_late_pct double precision,
  score integer not null,
  verdict text not null,
  risk text not null,
  ai_reason text,
  status text not null default 'analyzed',
  created_at timestamptz not null default now()
);

create table if not exists public.signal_market_snapshots (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references public.trade_signals (id) on delete cascade,
  current_price double precision,
  change_24h double precision,
  volume_24h double precision,
  turnover_24h double precision,
  rsi_1h double precision,
  ema_20_1h double precision,
  ema_50_1h double precision,
  atr_14_1h double precision,
  volume_spike double precision,
  spread_pct double precision,
  oi_change_1h double precision,
  oi_change_4h double precision,
  oi_change_24h double precision,
  funding_rate double precision,
  long_short_ratio double precision,
  raw_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.signal_orders (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  signal_id uuid references public.trade_signals (id) on delete set null,
  bybit_order_id text,
  symbol text not null,
  side text not null,
  order_type text not null,
  price double precision,
  qty double precision,
  amount_usdt double precision,
  status text not null default 'created',
  raw_response jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_telegram_signal_posts_user on public.telegram_signal_posts (telegram_user_id);
create index if not exists idx_trade_signals_user on public.trade_signals (telegram_user_id);
create index if not exists idx_signal_snapshots_signal on public.signal_market_snapshots (signal_id);
