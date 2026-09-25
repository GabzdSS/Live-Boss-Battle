import WebSocket from "ws";

const EVENTSUB_WS = "wss://eventsub.wss.twitch.tv/ws";
const HELIX_SUBS = "https://api.twitch.tv/helix/eventsub/subscriptions";

/**
 * Conexao EventSub de UM canal - a mesma do SubPack, com outras inscricoes.
 *
 * A Twitch exige que todas as inscricoes de uma conexao WebSocket sejam do
 * mesmo usuario, entao e uma conexao por canal ativo. Passando de algumas
 * centenas de canais, a saida e migrar pro transporte por webhook.
 */

// message_id ja processado. A Twitch garante entrega "pelo menos uma vez",
// entao a mesma notificacao pode chegar duas vezes - e viraria golpe dobrado.
// (O banco tambem trava por source_ref; isto aqui so evita o trabalho.)
const idsVistos = new Set();

async function criarInscricao({ clientId, token, tipo, versao, broadcasterUserId, sessionId }) {
  const res = await fetch(HELIX_SUBS, {
    method: "POST",
    headers: { "Client-Id": clientId, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: tipo,
      version: versao,
      condition: { broadcaster_user_id: broadcasterUserId },
      transport: { method: "websocket", session_id: sessionId },
    }),
  });
  if (!res.ok) {
    const corpo = await res.text();
    const erro = new Error(`inscricao ${tipo} falhou: ${res.status} ${corpo.slice(0, 200)}`);
    erro.status = res.status;
    throw erro;
  }
  return res.json();
}

export const INSCRICOES = [
  // Resgate de recompensa de pontos do canal. Chega de TODAS as recompensas do
  // canal; quem decide se e "Ataque" e o runtime, pelo reward.id.
  { tipo: "channel.channel_points_custom_reward_redemption.add", versao: "1" },
  { tipo: "channel.cheer", versao: "1" },
];

export function conectarEventSub({ clientId, broadcasterUserId, obterToken, aoDisparar, aoPerderAutorizacao, rotulo = "" }) {
  let ws = null;
  let ultimaMensagemEm = Date.now();
  let vigia = null;
  let parado = false;
  const status = { conectado: false, inscricoes: {}, ultimaNotificacaoEm: null, ultimoErro: null };

  function log(...args) {
    console.log(`[eventsub${rotulo ? " " + rotulo : ""}]`, ...args);
  }

  async function conectar(url = EVENTSUB_WS) {
    if (parado) return;
    const socket = new WebSocket(url);
    ws = socket;
    ultimaMensagemEm = Date.now();
    status.conectado = false;

    socket.on("message", async (bruto) => {
      ultimaMensagemEm = Date.now();
      let msg;
      try {
        msg = JSON.parse(bruto.toString());
      } catch {
        return;
      }
      const tipo = msg.metadata?.message_type;

      if (tipo === "session_welcome") {
        const sessionId = msg.payload.session.id;
        status.conectado = true;
        status.inscricoes = {};
        const token = await obterToken();
        if (!token) {
          status.ultimoErro = "sem token valido";
          aoPerderAutorizacao?.("sem token valido");
          return parar();
        }

        for (const inscricao of INSCRICOES) {
          try {
            await criarInscricao({ clientId, token, ...inscricao, broadcasterUserId, sessionId });
            status.inscricoes[inscricao.tipo] = "ok";
          } catch (err) {
            if (err.status === 409) {
              // ja existe nessa sessao (acontece depois de session_reconnect) e segue valendo
              status.inscricoes[inscricao.tipo] = "ok";
            } else if (err.status === 401) {
              // Token recusado: reconectar nao resolve, a streamer precisa entrar de novo.
              status.inscricoes[inscricao.tipo] = "sem autorizacao";
              status.ultimoErro = err.message;
              aoPerderAutorizacao?.(err.message);
              return parar();
            } else if (err.status === 403) {
              // Diferente do SubPack, 403 aqui NAO derruba o canal: e o que a
              // Twitch responde pra canal que nao e Afiliado/Parceiro (sem
              // pontos nem bits). O token continua bom; o painel explica.
              status.inscricoes[inscricao.tipo] = "sem permissao (o canal e Afiliado ou Parceiro?)";
              status.ultimoErro = err.message;
              console.warn(`[eventsub ${rotulo}] ${err.message}`);
            } else {
              status.inscricoes[inscricao.tipo] = err.message.slice(0, 160);
              console.error(`[eventsub ${rotulo}] ${err.message}`);
            }
          }
        }
        log("conectado e inscrito");
      }

      if (tipo === "session_reconnect") {
        const anterior = ws;
        conectar(msg.payload.session.reconnect_url);
        setTimeout(() => anterior?.close(), 5000);
      }

      if (tipo === "revocation") {
        status.ultimoErro = `inscricao revogada: ${msg.payload?.subscription?.type}`;
        aoPerderAutorizacao?.(status.ultimoErro);
      }

      if (tipo === "notification") {
        const messageId = msg.metadata.message_id;
        if (idsVistos.has(messageId)) return;
        idsVistos.add(messageId);
        if (idsVistos.size > 20000) idsVistos.clear();

        status.ultimaNotificacaoEm = new Date().toISOString();
        const gatilho = traduzirEvento(msg.metadata.subscription_type, msg.payload.event, messageId);
        if (gatilho) aoDisparar(gatilho);
      }
    });

    socket.on("close", () => {
      if (ws === socket) status.conectado = false;
    });
    socket.on("error", (err) => {
      status.ultimoErro = err.message;
      console.error(`[eventsub ${rotulo}] erro:`, err.message);
    });
  }

  // A Twitch manda keepalive a cada ~10s. Silencio longo quase sempre e uma
  // conexao morta que nunca disparou "close" - sem esse vigia, o canal fica
  // mudo no meio da raid e ninguem percebe ate o chefao parar de apanhar.
  vigia = setInterval(() => {
    if (parado) return;
    const silencio = Date.now() - ultimaMensagemEm;
    if (silencio > 40000) {
      console.warn(`[eventsub ${rotulo}] ${Math.round(silencio / 1000)}s sem mensagem - reconectando`);
      ultimaMensagemEm = Date.now();
      try {
        ws?.terminate();
      } catch {
        // ja estava fechado
      }
      conectar();
    }
  }, 20000);

  function parar() {
    parado = true;
    clearInterval(vigia);
    try {
      ws?.close();
    } catch {
      // ja estava fechado
    }
    status.conectado = false;
  }

  conectar();

  return {
    parar,
    getStatus: () => ({ ...status, inscricoes: { ...status.inscricoes }, ultimaMensagemEm: new Date(ultimaMensagemEm).toISOString() }),
  };
}

/**
 * Traduz o evento da Twitch pro gatilho do jogo - o mesmo formato que o modo
 * de teste do painel vai produzir, pra os dois caminhos serem um so dali em diante.
 *
 * `ref` e a identidade do golpe: o id do resgate (unico na Twitch, e o que a
 * gente usa pra reembolsar) ou o message_id do cheer (cheer nao tem id proprio).
 * `userId` vai junto porque o login pode mudar e o ranking e por pessoa.
 */
export function traduzirEvento(tipo, evento, messageId) {
  if (tipo === "channel.channel_points_custom_reward_redemption.add") {
    return {
      origem: "resgate",
      ref: `resgate:${evento.id}`,
      redemptionId: evento.id,
      rewardId: evento.reward?.id,
      rewardTitulo: evento.reward?.title,
      custo: evento.reward?.cost,
      userId: evento.user_id,
      login: evento.user_login,
      username: evento.user_name,
    };
  }

  if (tipo === "channel.cheer") {
    return {
      origem: "cheer",
      ref: `cheer:${messageId}`,
      bits: evento.bits,
      // Cheer anonimo causa dano, mas nao tem quem colocar no ranking.
      anonimo: Boolean(evento.is_anonymous),
      userId: evento.is_anonymous ? null : evento.user_id,
      login: evento.is_anonymous ? null : evento.user_login,
      username: evento.is_anonymous ? "Anônimo" : evento.user_name,
    };
  }

  return null;
}
