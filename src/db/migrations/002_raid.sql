-- O jogo: configuracao do chefao, recompensas, raids e golpes.
-- Tudo com channel_id (regra de ouro do 001).

-- Configuracao atual do canal. A raid copia isto pra si ao comecar
-- (raids.config), entao mexer aqui durante uma raid nao muda a raid em andamento.
create table raid_settings (
  channel_id           uuid primary key references channels(id) on delete cascade,
  boss_nome            text        not null default 'Chefão',
  vida                 integer     not null default 5000 check (vida > 0),
  duracao_segundos     integer     not null default 600 check (duracao_segundos > 0),
  dano_por_bit         numeric     not null default 1 check (dano_por_bit >= 0),
  -- 0..1
  chance_critico       numeric     not null default 0.1 check (chance_critico >= 0 and chance_critico <= 1),
  multiplicador_critico numeric    not null default 2 check (multiplicador_critico >= 1),
  -- [{ "ate": 1, "armadura": 0, "imagem": null }, { "ate": 0.5, ... }, ...]
  -- "ate" = fracao da vida em que a fase comeca; armadura = fracao do dano absorvida
  fases                jsonb       not null default '[{"ate":1,"armadura":0,"imagem":null},{"ate":0.5,"armadura":0.2,"imagem":null},{"ate":0.25,"armadura":0.4,"imagem":null}]'::jsonb,
  updated_at           timestamptz not null default now()
);

-- Recompensas de pontos do canal que viram dano. O app cria na Twitch
-- (etapa 3) e guarda o id aqui: e por ele que o resgate vira golpe.
create table raid_rewards (
  channel_id        uuid        not null references channels(id) on delete cascade,
  chave             text        not null,          -- 'ataque' | 'ataque-forte'
  titulo            text        not null,
  custo             integer     not null check (custo > 0),
  dano              integer     not null check (dano > 0),
  twitch_reward_id  text,
  cooldown_segundos integer     not null default 0 check (cooldown_segundos >= 0),
  updated_at        timestamptz not null default now(),
  primary key (channel_id, chave)
);

create unique index raid_rewards_por_twitch_id on raid_rewards (twitch_reward_id) where twitch_reward_id is not null;

create table raids (
  id                  uuid primary key default gen_random_uuid(),
  channel_id          uuid        not null references channels(id) on delete cascade,
  -- rodando | pausada | vitoria | fuga | cancelada
  status              text        not null,
  -- copia da configuracao no momento do inicio (motor + recompensas)
  config              jsonb       not null,
  vida_max            integer     not null,
  vida                integer     not null,
  fase                integer     not null default 0,
  started_at          timestamptz not null default now(),
  -- prazo quando rodando; null quando pausada (ai vale paused_remaining_ms)
  ends_at             timestamptz,
  paused_remaining_ms integer,
  ended_at            timestamptz,
  -- raid iniciada pelo modo de teste: fica fora do historico e do hall da fama
  is_test             boolean     not null default false
);

-- No maximo UMA raid em andamento por canal - garantido pelo banco, nao por codigo.
create unique index raids_uma_ativa_por_canal on raids (channel_id) where status in ('rodando', 'pausada');
create index raids_por_canal on raids (channel_id, started_at desc);

create table raid_hits (
  id             bigserial primary key,
  raid_id        uuid        not null references raids(id) on delete cascade,
  channel_id     uuid        not null references channels(id) on delete cascade,
  -- quem bateu. Sem id (anonimo) fica fora do ranking; teste usa "teste:<login>"
  jogador        text,
  login          text,
  display_name   text        not null,
  origem         text        not null,          -- resgate | cheer | teste
  -- id do resgate / message_id do cheer: o mesmo evento nunca vira dois golpes
  source_ref     text        not null,
  bits           integer,
  recompensa     text,
  dano_base      integer     not null,
  dano_final     integer     not null,
  dano_efetivo   integer     not null,
  critico        boolean     not null default false,
  fase           integer     not null,
  created_at     timestamptz not null default now(),
  unique (raid_id, source_ref)
);

create index raid_hits_por_raid on raid_hits (raid_id, jogador);
