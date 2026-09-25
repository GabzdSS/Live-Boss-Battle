import crypto from "crypto";
import * as raids from "../repos/raids.js";
import * as raidConfig from "../repos/raidConfig.js";
import { aplicarGolpe, ordenarRanking } from "./boss.js";
import { emitirParaCanal } from "../web/sockets.js";

/**
 * A raid de cada canal: estado vivo, fila de golpes e timer.
 *
 * Vive fora do runtime da Twitch de proposito: o canal de teste (sem Twitch)
 * e o canal cuja conexao caiu no meio da live continuam com a raid de pe, e
 * o painel/modo de teste falam com o mesmo gerente que o EventSub.
 *
 * Tres garantias:
 *   1. golpes do canal passam por UMA fila - dois resgates no mesmo milissegundo
 *      nao leem a mesma vida (o timer de fuga entra na mesma fila)
 *   2. o banco e a verdade: golpe e vida gravados juntos, e o mesmo evento da
 *      Twitch (source_ref) nunca vira dois golpes
 *   3. reinicio do servidor recarrega a raid e o ranking; se o prazo venceu
 *      enquanto estava fora, o chefao fugiu
 */

const gerentes = new Map(); // channelId -> gerente
const TOP_OVERLAY = 5;
const TOP_FINAL = 10;

export function raidDoCanal(channelId, opcoes = {}) {
  let gerente = gerentes.get(channelId);
  if (!gerente) {
    gerente = criarGerente(channelId, opcoes);
    gerentes.set(channelId, gerente);
  }
  return gerente;
}

/** Tira o canal da memoria (conta excluida, testes). Nao mexe no banco. */
export function esquecer(channelId) {
  gerentes.get(channelId)?.desligar();
  gerentes.delete(channelId);
}

/** Arranque do servidor: toda raid que estava em andamento volta a contar. */
export async function restaurarRaidsAtivas() {
  const ativas = await raids.todasAtivas();
  for (const raid of ativas) {
    try {
      await raidDoCanal(raid.channelId).carregar();
    } catch (err) {
      console.error(`[raid] falha ao restaurar raid ${raid.id}:`, err.message);
    }
  }
  if (ativas.length) console.log(`[raid] ${ativas.length} raid(s) em andamento restaurada(s)`);
}

/** Snapshot pra quem acabou de conectar (overlay recarregado no OBS, painel aberto). */
export async function snapshotDoCanal(channelId) {
  const gerente = raidDoCanal(channelId);
  await gerente.pronto();
  return gerente.snapshot();
}

function criarGerente(channelId, { agora = Date.now, sortear = Math.random, emitir = emitirParaCanal } = {}) {
  let raid = null;
  let ranking = new Map(); // jogador -> { jogador, nome, dano, golpes }
  let timer = null;
  let fila = Promise.resolve();
  let carregado = null;
  const ouvintes = new Set();

  /** Tudo que muda a raid passa por aqui, um de cada vez. */
  function enfileirar(fn) {
    const tarefa = fila.then(fn);
    fila = tarefa.catch(() => {});
    return tarefa;
  }

  function avisar(evento, payload) {
    emitir(channelId, evento, payload);
    for (const ouvinte of ouvintes) {
      try {
        ouvinte(evento, payload);
      } catch (err) {
        console.error("[raid] ouvinte falhou:", err.message);
      }
    }
  }

  const topRanking = (limite) => ordenarRanking([...ranking.values()], limite);

  function restanteMs() {
    if (!raid) return 0;
    if (raid.status === "pausada") return raid.pausedRemainingMs ?? 0;
    return Math.max(0, new Date(raid.endsAt).getTime() - agora());
  }

  function snapshot() {
    if (!raid) return { status: "ociosa", agora: agora() };
    const c = raid.config;
    return {
      status: raid.status,
      raidId: raid.id,
      teste: raid.isTest,
      bossNome: c.bossNome,
      vida: raid.vida,
      vidaMax: raid.vidaMax,
      fase: raid.fase,
      fases: c.fases,
      // O overlay desenha a contagem com endsAt + a hora do servidor (agora),
      // corrigindo o relogio do PC da streamer; o servidor e quem decide o fim.
      endsAt: raid.endsAt ? new Date(raid.endsAt).toISOString() : null,
      restanteMs: restanteMs(),
      agora: agora(),
      ranking: topRanking(TOP_OVERLAY),
      recompensas: Object.values(c.recompensas ?? {}).map((r) => ({ titulo: r.titulo, custo: r.custo, dano: r.dano })),
    };
  }

  function limparTimer() {
    clearTimeout(timer);
    timer = null;
  }

  function agendarFuga() {
    limparTimer();
    if (raid?.status !== "rodando") return;
    // setTimeout estoura acima de ~24,8 dias; raid dura no maximo 6h, mas o teto evita surpresa.
    const espera = Math.min(restanteMs(), 2 ** 31 - 1);
    timer = setTimeout(() => {
      enfileirar(async () => {
        if (raid?.status !== "rodando") return;
        if (restanteMs() > 0) return agendarFuga(); // relogio adiantou: agenda o resto
        await finalizar("fuga");
      }).catch((err) => console.error("[raid] falha no timer:", err.message));
    }, espera);
    timer.unref?.();
  }

  async function finalizar(status) {
    limparTimer();
    const atual = raid;
    const fechada = await raids.finalizar(channelId, atual.id, status);
    raid = null;
    if (!fechada) return null; // ja tinha sido fechada por outro caminho

    const final = {
      status,
      raidId: atual.id,
      teste: atual.isTest,
      bossNome: atual.config.bossNome,
      vida: atual.vida,
      vidaMax: atual.vidaMax,
      ranking: topRanking(TOP_FINAL),
      golpeFinal: status === "vitoria" ? await raids.golpeFinal(channelId, atual.id) : null,
      duracaoMs: new Date(fechada.endedAt).getTime() - new Date(atual.startedAt).getTime(),
    };
    ranking = new Map();
    avisar("raid:fim", final);
    avisar("raid:estado", snapshot());
    return final;
  }

  /** Traduz o gatilho (Twitch ou teste) no golpe que o motor entende. */
  function golpeDoGatilho(gatilho) {
    if (gatilho.origem === "cheer") return { tipo: "bits", bits: gatilho.bits };
    if (gatilho.origem === "resgate") {
      const nossa = Object.entries(raid.config.recompensas ?? {}).find(([, r]) => r.twitchRewardId && r.twitchRewardId === gatilho.rewardId);
      return nossa ? { tipo: "recompensa", chave: nossa[0] } : null;
    }
    if (gatilho.origem === "teste") {
      return gatilho.bits ? { tipo: "bits", bits: gatilho.bits } : { tipo: "recompensa", chave: gatilho.recompensa };
    }
    return null;
  }

  async function processarGolpe(gatilho) {
    if (!raid) return { ok: false, motivo: "sem-raid" };

    const golpe = golpeDoGatilho(gatilho);
    // Resgate de outra recompensa do canal (nao e nossa): nao e golpe, e nao
    // pode ser reembolsado por nos - quem chama so ignora.
    if (!golpe) return { ok: false, motivo: "nao-e-golpe" };

    // Pausa congela o timer e as recompensas de pontos. Bits nao tem
    // reembolso, entao cheer durante a pausa continua batendo (decisao da etapa 0).
    if (raid.status === "pausada" && golpe.tipo !== "bits") return { ok: false, motivo: "pausada" };

    const r = aplicarGolpe({ vida: raid.vida, vidaMax: raid.vidaMax, fase: raid.fase }, raid.config, golpe, sortear);
    if (!r.ok) return r;

    const jogador = gatilho.anonimo ? null : gatilho.userId ? String(gatilho.userId) : gatilho.origem === "teste" ? `teste:${gatilho.login}` : null;
    const nome = gatilho.username || gatilho.login || "Anônimo";
    const gravado = await raids.registrarGolpe(
      channelId,
      raid.id,
      {
        jogador,
        login: gatilho.login ?? null,
        nome,
        origem: gatilho.origem,
        ref: gatilho.ref,
        bits: golpe.tipo === "bits" ? Math.floor(golpe.bits) : null,
        recompensa: golpe.chave ?? null,
        ...r.resultado,
      },
      r.estado
    );
    if (gravado.duplicado) return { ok: false, motivo: "duplicado" };

    raid.vida = r.estado.vida;
    raid.fase = r.estado.fase;
    if (jogador) {
      const linha = ranking.get(jogador) ?? { jogador, nome, dano: 0, golpes: 0 };
      linha.dano += r.resultado.danoEfetivo;
      linha.golpes += 1;
      linha.nome = nome;
      ranking.set(jogador, linha);
    }

    avisar("raid:golpe", {
      nome,
      origem: gatilho.origem,
      bits: golpe.tipo === "bits" ? Math.floor(golpe.bits) : null,
      recompensa: golpe.chave ? raid.config.recompensas[golpe.chave]?.titulo : null,
      ...r.resultado,
      vida: raid.vida,
      vidaMax: raid.vidaMax,
      ranking: topRanking(TOP_OVERLAY),
    });
    for (const e of r.eventos) {
      if (e.tipo === "fase") avisar("raid:fase", { fase: e.fase, de: e.de, imagem: raid.config.fases[e.fase]?.imagem ?? null, armadura: raid.config.fases[e.fase]?.armadura ?? 0 });
    }

    const derrotado = r.eventos.some((e) => e.tipo === "derrotado");
    if (derrotado) await finalizar("vitoria");
    return { ok: true, ...r.resultado, vida: r.estado.vida, derrotado };
  }

  const gerente = {
    snapshot,

    /** Garante que o estado do banco ja foi lido (uma vez). */
    pronto() {
      if (!carregado) carregado = gerente.carregar();
      return carregado;
    },

    carregar() {
      carregado = enfileirar(async () => {
        raid = await raids.ativa(channelId);
        ranking = new Map();
        if (!raid) return;
        for (const linha of await raids.rankingDaRaid(channelId, raid.id)) ranking.set(linha.jogador, linha);
        if (raid.status === "rodando") {
          if (restanteMs() <= 0) {
            console.log(`[raid] canal ${channelId}: prazo venceu com o servidor fora - o chefão fugiu`);
            await finalizar("fuga");
          } else {
            agendarFuga();
          }
        }
      });
      return carregado;
    },

    async iniciar({ teste = false } = {}) {
      await gerente.pronto();
      return enfileirar(async () => {
        if (raid) {
          const erro = new Error("Já existe uma raid em andamento neste canal.");
          erro.codigo = "ja-tem-raid";
          throw erro;
        }
        const config = await raidConfig.obter(channelId);
        const recompensas = await raidConfig.listarRecompensas(channelId);
        // Copia da config: mexer no painel durante a raid nao muda a raid em andamento.
        const snapshotConfig = {
          ...config,
          recompensas: Object.fromEntries(
            recompensas.map((r) => [r.chave, { titulo: r.titulo, custo: r.custo, dano: r.dano, twitchRewardId: r.twitchRewardId }])
          ),
        };
        raid = await raids.criar(channelId, {
          config: snapshotConfig,
          vidaMax: config.vida,
          endsAt: new Date(agora() + config.duracaoSegundos * 1000),
          isTest: teste,
        });
        ranking = new Map();
        agendarFuga();
        const estado = snapshot();
        avisar("raid:estado", estado);
        return estado;
      });
    },

    async pausar() {
      await gerente.pronto();
      return enfileirar(async () => {
        if (raid?.status !== "rodando") return { ok: false, motivo: raid ? "ja-pausada" : "sem-raid" };
        const atualizada = await raids.pausar(channelId, raid.id, restanteMs());
        raid = { ...raid, ...atualizada };
        limparTimer();
        avisar("raid:estado", snapshot());
        return { ok: true, estado: snapshot() };
      });
    },

    async retomar() {
      await gerente.pronto();
      return enfileirar(async () => {
        if (raid?.status !== "pausada") return { ok: false, motivo: raid ? "nao-pausada" : "sem-raid" };
        const atualizada = await raids.retomar(channelId, raid.id, new Date(agora() + (raid.pausedRemainingMs ?? 0)));
        raid = { ...raid, ...atualizada };
        agendarFuga();
        avisar("raid:estado", snapshot());
        return { ok: true, estado: snapshot() };
      });
    },

    /** Encerrar pelo painel: nem vitoria nem fuga. */
    async encerrar() {
      await gerente.pronto();
      return enfileirar(async () => {
        if (!raid) return { ok: false, motivo: "sem-raid" };
        return { ok: true, final: await finalizar("cancelada") };
      });
    },

    /**
     * Golpe vindo da Twitch (EventSub) ou do modo de teste - mesmo caminho.
     * gatilho: { origem, ref, userId, login, username, anonimo?, bits?, rewardId?, recompensa? }
     */
    async golpear(gatilho) {
      await gerente.pronto();
      return enfileirar(() => processarGolpe(gatilho));
    },

    /** Recebe cada evento da raid (o chat usa pra anunciar). Devolve o "desinscrever". */
    ouvir(fn) {
      ouvintes.add(fn);
      return () => ouvintes.delete(fn);
    },

    desligar() {
      limparTimer();
      ouvintes.clear();
    },
  };
  return gerente;
}

/** Gatilho do modo de teste: mesmo formato do EventSub, com ref unica. */
export function gatilhoDeTeste({ nome, recompensa, bits }) {
  const login = String(nome || "viewer_teste").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 25) || "viewer_teste";
  return {
    origem: "teste",
    ref: `teste:${crypto.randomUUID()}`,
    userId: null,
    login,
    username: String(nome || login).slice(0, 25),
    bits: bits ? Math.floor(Number(bits)) : null,
    recompensa: bits ? null : recompensa,
  };
}
