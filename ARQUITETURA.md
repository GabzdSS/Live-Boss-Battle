# Boss Raid — arquitetura proposta

Documento vivo. Etapa 0: desenho aprovado antes de qualquer código.

Base: o SubPack (repositório `CardPacks`, pasta `src/`, a versão SaaS
multi-canal — não o `server/` legado). A Boss Raid copia a plataforma dele e
troca só o jogo.

## O que vem igual do SubPack

| Camada | No SubPack | Na Boss Raid |
|---|---|---|
| Runtime | Node ≥18, ESM, Express 4, Socket.io 4, `ws`, `tmi.js` | igual |
| Banco | Postgres (`pg`) em produção, PGlite em dev, migrations `.sql` numeradas | igual |
| Login | "Entrar com a Twitch" (authorization code + `state` anti-CSRF), tokens cifrados AES-256-GCM no banco, refresh automático | igual, escopos diferentes |
| Sessão | cookie assinado httpOnly (`lib/session.js`) | igual |
| Eventos | EventSub **WebSocket**, uma conexão por canal, dedupe por `message_id`, vigia de keepalive, reconexão | igual, inscrições diferentes |
| Chat | `tmi.js` com a conta da própria streamer | igual, comandos diferentes |
| Multi-canal | `supervisor` liga/desliga o runtime de cada canal; todo repo recebe `channelId` primeiro | igual |
| Overlay | `/overlay/<overlay_token>` → Socket.io em **sala por canal** | igual |
| Animação | `overlay-anim.js` separado da conexão, usado também na demo da vitrine | igual |
| Painel | páginas estáticas em `public/app/`, API `/api/painel/*` com canal vindo da sessão | igual |
| Cobrança | `billing/` com provider `manual` e `mercadopago` | igual (assinatura própria do produto) |
| Deploy | Dockerfile + Fly.io, **uma máquina**, sem auto-stop | igual |
| Dev | `/dev/canal-de-teste` cria canal falso logado | igual |

## Estrutura de pastas

```
src/
  server.js
  config/env.js
  db/            index.js, migrate.js, migrations/
                   001_plataforma.sql   (channels, channel_tokens, subscriptions, sessions, oauth_states — copiado)
                   002_raid.sql         (tabelas do jogo, abaixo)
  lib/           secretBox, ids, session, storage (imagem do chefão)
  twitch/
    oauth.js     escopos da Boss Raid
    eventsub.js  inscrições: resgate de recompensa + cheer
    rewards.js   NOVO — Helix: criar/atualizar/ligar/desligar recompensas, FULFILLED/CANCELED
    chat.js      anúncios da raid + !raid, !dano
  domain/
    boss.js      NOVO — motor puro: dano, crítico, armadura, fases, morte (sem I/O, testável)
    raid.js      NOVO — orquestra: fila por canal, grava golpe, emite overlay, anuncia chat
  repos/         channels, subscriptions, raidConfig, raids
  runtime/       supervisor.js, canal.js (canal ganha a raid ativa + timer)
  billing/       copiado
  web/
    app.js, sockets.js, middleware.js
    routes/      auth, painel, painelRaid, painelTeste, publico, webhooks, dev
public/
  overlay.html, overlay.js (só conexão), overlay-anim.js (motor), overlay.css
  app/           base.css, inicio, entrar, painel (config), ao-vivo (controles + teste), assinatura, termos, privacidade
```

## Twitch

**App próprio no console da Twitch (Client ID separado do SubPack).** A Twitch só
deixa reembolsar resgates de recompensas criadas pelo **mesmo Client ID**, então as
recompensas pertencem ao app da Boss Raid. Com um app por produto, cada um pede só
os escopos de que precisa, e remover um não derruba o outro.

Escopos pedidos à streamer:

| Escopo | Por quê |
|---|---|
| `channel:manage:redemptions` | criar/editar as recompensas, marcar resgate como concluído ou reembolsado, e também ler resgates pelo EventSub |
| `bits:read` | EventSub `channel.cheer` |
| `user:read:email` | contato de cobrança e aviso de token vencido (igual ao SubPack) |
| `chat:read` `chat:edit` | anúncios e comandos no chat |

Inscrições EventSub (WebSocket, condição `broadcaster_user_id`):

- `channel.channel_points_custom_reward_redemption.add` v1
- `channel.cheer` v1

Requisito do canal: **Afiliado ou Parceiro** (sem isso não existem pontos nem
bits). A criação da recompensa devolve 403 nesse caso, e o painel explica isso em
vez de falhar calado.

### Ciclo de vida das recompensas

As recompensas "Ataque" e "Ataque Forte" são criadas pelo app ao salvar a
configuração (ou recriadas se a streamer apagar uma na Twitch: 404 no update →
cria de novo).

| Estado da raid | Recompensa na Twitch |
|---|---|
| sem raid | `is_enabled = false` (some do menu do chat) |
| rodando | `is_enabled = true`, `is_paused = false` |
| pausada | `is_paused = true` (aparece, mas não aceita resgate) |
| terminou | `is_enabled = false` |

- `should_redemptions_skip_request_queue = false` **obrigatório**: resgate que
  pula a fila já nasce `FULFILLED` e não pode mais ser reembolsado.
- Resgate com raid rodando → aplica o dano e marca `FULFILLED`.
- Resgate sem raid rodando (corrida entre desligar e o viewer clicar, servidor
  reiniciando) → `CANCELED` = pontos devolvidos.
- Ao ligar o runtime do canal: busca resgates `UNFULFILLED` das nossas
  recompensas e reembolsa os que não viraram golpe. Isso cobre o servidor ter
  caído no meio da live.
- Título duplicado (a streamer já tem uma recompensa manual chamada "Ataque") →
  a Twitch recusa; o painel mostra e sugere outro nome.
- Cooldown global e limite por viewer por live configuráveis (anti-spam), pelos
  campos nativos da Twitch.

### Cheers

Bits não têm reembolso. Regras propostas:

- Raid rodando ou pausada → vira dano (a pausa congela o timer, não o chefão).
- Sem raid → não vira dano; o painel mostra e o bot pode agradecer.
- Cheer anônimo → causa dano como "Anônimo", fica fora do ranking.

## Jogo

### Motor (`domain/boss.js`, sem I/O)

```
dano_base  = recompensa.dano             (pontos)
           = bits × dano_por_bit          (cheer)
crítico    = cheer E random < chance_critico  → dano_base × multiplicador_critico
dano_final = arredonda(dano_base × (1 − armadura_da_fase_atual))
dano_efetivo = min(dano_final, vida_restante)   ← entra no ranking
```

- Fases configuráveis, padrão: `100%` (armadura 0), `≤50%` (armadura 0.2),
  `≤25%` (armadura 0.4), cada uma com imagem própria (sem imagem → efeito
  visual automático de cor/tremor no overlay).
- Um golpe que cruza duas fases emite as duas transições, em ordem.
- A armadura usada é a da fase **no momento do golpe**.
- Devolve `{ estado novo, eventos: [golpe, critico?, mudou-de-fase*, derrotado?] }`.

### Estados da raid

```
ociosa ──iniciar──> rodando <──pausar/retomar──> pausada
                      │
          vida 0 ─────┼───── tempo 0 ───── encerrar (painel)
             ▼        ▼          ▼
          vitória   fuga     cancelada
```

- Timer do lado do servidor: grava `ends_at`; pausar guarda o tempo restante;
  o overlay recebe `ends_at` + hora do servidor e só desenha a contagem.
- Uma raid ativa por canal, garantido por índice único no banco (mesmo padrão de
  "uma temporada ativa" do SubPack).
- Golpes do canal passam por uma **fila serial** (cadeia de promises), para que
  dois golpes simultâneos não leiam a mesma vida.
- Reinício do servidor: o runtime recarrega a raid ativa do banco e reagenda o
  timer; se o prazo venceu enquanto estava fora, fecha como fuga.

### Banco (`002_raid.sql`, tudo com `channel_id`)

- `raid_settings`: nome e imagens do chefão, vida, duração, dano por bit,
  chance e multiplicador de crítico, fases (jsonb).
- `raid_rewards`: `key` (ataque/ataque-forte), título, custo, dano,
  `twitch_reward_id`, cooldown/limites.
- `raids`: status, snapshot da config usada, vida máx./atual, fase, `started_at`,
  `ends_at`, `paused_remaining_ms`, `ended_at`, resultado, `is_test`.
- `raid_hits`: golpe a golpe (`twitch_user_id`, login, nome, origem
  `reward|cheer|teste`, `source_ref`, bits, dano base/final/efetivo, crítico,
  fase). **`unique (raid_id, source_ref)`**: o id do resgate ou da mensagem
  de cheer impede golpe em dobro mesmo se o evento chegar duas vezes.
- `raid_events`: feed do painel (reembolsos, erros, mudanças de fase).

Ranking = soma de `raid_hits` por `twitch_user_id` (mantido também em memória
durante a raid, para não ir ao banco a cada golpe).

## Overlay

`/overlay/<token>` → sala `canal:<id>`. Eventos:

| Evento | Quando |
|---|---|
| `raid:estado` | ao conectar e a cada mudança de status (snapshot completo: o OBS pode recarregar a fonte a qualquer hora) |
| `raid:golpe` | cada golpe (agrupado a cada ~100 ms quando chove resgate) |
| `raid:fase` | troca de visual + animação de "enfurecer" |
| `raid:fim` | vitória (tela com top contribuintes) ou fuga |

Tela: chefão ao centro, barra de vida com "vida fantasma" (a perda aparece e
depois escoa), timer, top 5 fixo, números de dano subindo (crítico maior e com
cor própria). Regras herdadas do SubPack: só `transform`/`opacity`,
efeitos medidos em `vmin`, `prefers-reduced-motion`, e o mesmo
`overlay-anim.js` na demo da vitrine.

## Painel da streamer

- **`/painel`**: configuração do chefão (nome, imagem por fase, vida, tempo,
  dano por bit, crítico, armaduras), recompensas (título, custo, dano,
  cooldown), URL do overlay para o OBS, status das conexões e dos requisitos
  (Afiliado? recompensas criadas?).
- **`/painel/ao-vivo`**: iniciar, pausar/retomar, encerrar; vida e timer ao vivo;
  feed de golpes e reembolsos; ranking.

## Modo de teste

No `/painel/ao-vivo`, bloco "Testar sem estar ao vivo":

- simular resgate (nome do viewer + qual recompensa);
- simular cheer (nome + bits, ou anônimo);
- **rajada**: N viewers fictícios atacando por X segundos (testa fila, overlay
  sob carga e mudança de fase).

Tudo passa pela **mesma função** que o EventSub chama (`raid.processarGolpe`),
com origem `teste` e sem chamar a Twitch (nada de FULFILLED/CANCELED). Uma raid
iniciada em modo teste fica marcada `is_test` e não entra no histórico nem no
hall da fama. Funciona no canal falso do `/dev/canal-de-teste`, sem Twitch.

## Premiação (a Twitch não permite dar pontos de canal)

| Opção | Como | Fase |
|---|---|---|
| Anúncio no chat | top 3 + último golpe anunciados pelo bot ao final | MVP |
| Hall da fama | "Matou o último chefão" e recordes, exibidos no overlay da próxima raid e numa página pública do canal | MVP |
| Pacote do SubPack | top N (ou quem deu o golpe final) ganha um pacote. API interna entre os produtos, assinada com HMAC, canal casado pelo `twitch_user_id`; só aparece se o canal também usar o SubPack | fase 2 |
| VIP temporário | `channel:manage:vips`, com remoção agendada depois de X dias; escopo pedido só quando a streamer ativar | fase 2 |
| Destaque no chat | `/announcement` colorido com o nome do campeão (`moderator:manage:announcements`) | fase 2 |

## Etapas de implementação (depois deste desenho aprovado)

1. **Plataforma** — **pronta**: config/db/lib/oauth/sessão/supervisor/sockets/billing
   copiados do SubPack, escopos novos, EventSub de resgate + cheer chegando no
   feed do painel, overlay conectando por token, `/dev/canal-de-teste`.
2. **Motor do chefão** — **pronto**: `boss.js` (dano, crítico, armadura, fases,
   ranking) e `raid.js` (fila por canal, timer de fuga, pausa, persistência,
   restauração no arranque), API `/api/painel/raid/*` com golpe de teste.
   27 testes (`npm test`), incluindo 50 golpes simultâneos e reinício.
3. **Twitch**: EventSub (resgate + cheer), `rewards.js` com o ciclo de vida
   e o reembolso, anúncios no chat.
4. **Overlay** animado.
5. **Painel** (config + ao vivo) e **modo de teste**.
6. Vitrine, cobrança ligada, deploy (mesmo runbook do SubPack).

## Riscos

- **Chuva de resgates**: 200 resgates em 10 s = 200 PATCH na Helix. Limite
  de ~800 req/min por token: dá, mas os FULFILLED vão por uma fila com
  limite de vazão, fora do caminho do dano (o overlay não espera a Twitch).
- **Token revogado no meio da raid**: igual ao SubPack (painel pede
  reconexão). Os resgates que ficarem pendentes são reembolsados pela varredura
  quando o canal voltar.
- **Código duplicado entre produtos**: a plataforma copiada vai divergir com
  o tempo. Quando o terceiro produto chegar, extrair `plataforma/` para um
  pacote compartilhado.
