import { config } from "../config/env.js";
import { criarChat } from "../twitch/chat.js";
import { conectarEventSub } from "../twitch/eventsub.js";
import { emitirParaCanal } from "../web/sockets.js";
import * as channels from "../repos/channels.js";
import * as eventos from "../repos/eventos.js";

const HORAS = 60 * 60 * 1000;

/**
 * Runtime de um canal: a conexao com a Twitch (eventos + chat) e o estado vivo
 * daquela streamer. Tudo que fala com o mundo passa pelo `ctx`, e o ctx so
 * conhece um canal - e isso que impede o golpe de um canal cair no chefao de outro.
 *
 * Etapa 1: os eventos da Twitch chegam, vao pro feed do painel e param ai.
 * A raid (dano, reembolso, overlay) se pluga em `ctx.receberGatilho` na etapa 2/3.
 */

/** Contexto sem Twitch: o painel usa pra agir no canal mesmo com a conexao caida. */
export function criarContexto(canal, extras = {}) {
  const ctx = {
    canal,
    emitir: (evento, payload) => emitirParaCanal(canal.id, evento, payload),
    ...extras,
  };
  ctx.receberGatilho = async (gatilho) => {
    await eventos.registrar(canal.id, `twitch:${gatilho.origem}`, gatilho);
    ctx.emitir("twitch-evento", { ...gatilho, at: new Date().toISOString() });
  };
  return ctx;
}

export async function iniciarCanal(canal) {
  const ctx = criarContexto(canal);
  const chat = criarChat(ctx);
  ctx.dizer = (mensagem) => chat.dizer(mensagem);

  const token = await channels.getAccessToken(canal.id);
  if (!token) {
    console.warn(`[runtime] ${canal.login}: sem token valido, canal nao vai conectar na Twitch`);
    return {
      canal,
      ctx,
      precisaReconectar: true,
      status: () => ({ precisaReconectar: true, chat: { conectado: false }, eventsub: { conectado: false } }),
      parar: async () => {},
    };
  }

  await chat.conectar(token);

  const eventsub = conectarEventSub({
    rotulo: canal.login,
    clientId: config.twitch.clientId,
    broadcasterUserId: canal.twitch_user_id,
    obterToken: () => channels.getAccessToken(canal.id),
    aoDisparar: (gatilho) => {
      ctx.receberGatilho(gatilho).catch((err) => console.error(`[runtime ${canal.login}] falha ao tratar evento:`, err.message));
    },
    aoPerderAutorizacao: (motivo) => {
      channels.markTokenInvalid(canal.id, motivo).catch(() => {});
      console.warn(`[runtime] ${canal.login} perdeu autorizacao: ${motivo}`);
    },
  });

  // O token da Twitch dura ~4h: numa live longa ele vence no meio. Renovar a
  // cada 3h mantem chat e EventSub de pe sem ninguem precisar fazer nada.
  const renovacao = setInterval(async () => {
    const novo = await channels.getAccessToken(canal.id, { margemMs: 90 * 60 * 1000 });
    if (novo) await chat.atualizarToken(novo);
  }, 3 * HORAS);

  return {
    canal,
    ctx,
    chat,
    eventsub,
    precisaReconectar: false,
    status: () => ({
      precisaReconectar: false,
      chat: chat.getStatus(),
      eventsub: eventsub.getStatus(),
    }),
    async parar() {
      clearInterval(renovacao);
      eventsub.parar();
      await chat.desconectar();
    },
  };
}
