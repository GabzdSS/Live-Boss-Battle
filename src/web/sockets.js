import { Server } from "socket.io";
import { config } from "../config/env.js";
import { readSession } from "../lib/session.js";
import * as channels from "../repos/channels.js";

/**
 * Socket.io separado por canal.
 *
 * O app antigo fazia io.emit() - um broadcast pra todo mundo conectado. Com
 * varios canais no mesmo processo isso seria o pior bug possivel: o overlay
 * de um cliente mostrando o chefao de outro, ao vivo. Aqui ninguem recebe nada
 * sem antes entrar numa sala `canal:<id>`, e so entra quem provou de qual
 * canal e (token do overlay na URL, ou cookie de sessao no painel).
 */

const sala = (channelId) => `canal:${channelId}`;

let io = null;
let aoConectar = null;

/**
 * Quem acabou de conectar precisa do estado inteiro na hora: o OBS recarrega
 * a fonte do navegador quando quer (trocar de cena, reabrir o OBS), e o
 * overlay nao pode ficar vazio esperando o proximo golpe.
 */
export function definirAoConectar(fn) {
  aoConectar = fn;
}

export function iniciarSockets(httpServer) {
  io = new Server(httpServer, { cors: { origin: false } });

  io.use(async (socket, next) => {
    try {
      const { overlay, painel } = socket.handshake.query ?? {};

      if (overlay) {
        const canal = await channels.findByOverlayToken(String(overlay));
        if (!canal) return next(new Error("Token de overlay inválido"));
        socket.data = { channelId: canal.id, papel: "overlay", login: canal.login };
        return next();
      }

      if (painel) {
        const cookieBruto = socket.handshake.headers.cookie ?? "";
        const valor = cookieBruto
          .split(";")
          .map((p) => p.trim())
          .find((p) => p.startsWith(`${config.session.cookieName}=`))
          ?.slice(config.session.cookieName.length + 1);
        const sessao = await readSession(decodeURIComponent(valor ?? ""));
        if (!sessao) return next(new Error("Sessão inválida"));
        socket.data = { channelId: sessao.channelId, papel: "painel", login: sessao.login };
        return next();
      }

      next(new Error("Conexão sem identificação de canal"));
    } catch (err) {
      next(err);
    }
  });

  io.on("connection", (socket) => {
    socket.join(sala(socket.data.channelId));
    console.log(`[socket] ${socket.data.papel} conectado ao canal ${socket.data.login}`);
    Promise.resolve(aoConectar?.(socket)).catch((err) => console.error("[socket] estado inicial:", err.message));
  });

  return io;
}

/** Manda um evento so pros clientes daquele canal. */
export function emitirParaCanal(channelId, evento, payload) {
  io?.to(sala(channelId)).emit(evento, payload);
}

/** Quantos overlays daquele canal estao abertos (o painel mostra isso). */
export function contarOverlays(channelId) {
  if (!io) return 0;
  let total = 0;
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data?.channelId === channelId && socket.data.papel === "overlay") total++;
  }
  return total;
}
