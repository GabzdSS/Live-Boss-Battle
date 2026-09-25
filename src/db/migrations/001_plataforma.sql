-- Plataforma: conta, tokens, assinatura e sessao.
--
-- Mesmo esquema do SubPack (ja consolidado, sem as migrations de ajuste que
-- ele teve pelo caminho). As tabelas do jogo chegam em 002.
--
-- Regra de ouro deste banco: tudo que e dado de canal carrega channel_id.
-- Um WHERE sem channel_id e um vazamento entre clientes.

create table channels (
  id              uuid primary key default gen_random_uuid(),
  twitch_user_id  text        not null unique,
  login           text        not null unique,
  display_name    text        not null,
  email           text,
  avatar_url      text,
  -- endereco publico do canal (hall da fama): /c/<slug>
  slug            text        not null unique,
  -- URL secreta do overlay: quem tem o link ve o chefao (vai no OBS)
  overlay_token   text        not null unique,
  settings        jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Credenciais da Twitch da streamer. access/refresh ficam cifrados (AES-256-GCM);
-- o banco nunca ve o token em claro.
create table channel_tokens (
  channel_id     uuid primary key references channels(id) on delete cascade,
  access_token   text        not null,
  refresh_token  text        not null,
  scopes         text[]      not null default '{}',
  expires_at     timestamptz,
  -- marcado quando a Twitch recusa o refresh (senha trocada, app removido):
  -- o painel usa isso pra pedir "reconectar sua conta" em vez de ficar mudo
  invalid_at     timestamptz,
  invalid_reason text,
  updated_at     timestamptz not null default now()
);

create table subscriptions (
  channel_id          uuid primary key references channels(id) on delete cascade,
  provider            text        not null default 'manual',
  external_id         text,
  plan                text        not null default 'basico',
  -- trialing | active | past_due | canceled
  status              text        not null default 'trialing',
  trial_ends_at       timestamptz,
  current_period_end  timestamptz,
  -- carencia depois de falha de pagamento: ainda funciona, ja avisa
  grace_until         timestamptz,
  checkout_url        text,
  ultimo_pagamento_em timestamptz,
  raw                 jsonb       not null default '{}'::jsonb,
  updated_at          timestamptz not null default now()
);

-- Rastro de cobranca. O id e o do provedor (notificacao + recurso): e o que
-- torna o webhook idempotente de verdade.
create table billing_events (
  id          text        primary key,
  channel_id  uuid        references channels(id) on delete cascade,
  provider    text        not null,
  kind        text        not null,
  status      text,
  raw         jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index billing_events_por_canal on billing_events (channel_id, created_at desc);

-- Feed do painel: eventos da Twitch, golpes, reembolsos, erros.
create table channel_events (
  id         bigserial primary key,
  channel_id uuid        not null references channels(id) on delete cascade,
  kind       text        not null,
  payload    jsonb       not null,
  created_at timestamptz not null default now()
);

create index eventos_recentes on channel_events (channel_id, created_at desc);

create table sessions (
  id         text primary key,
  channel_id uuid        not null references channels(id) on delete cascade,
  user_agent text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Estado anti-CSRF do "Entrar com a Twitch" (vive poucos minutos).
create table oauth_states (
  state       text primary key,
  redirect_to text,
  created_at  timestamptz not null default now()
);
