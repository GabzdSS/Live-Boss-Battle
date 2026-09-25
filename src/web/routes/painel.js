import express from "express";
import { requireSession } from "../middleware.js";
import { contarOverlays } from "../sockets.js";
import { getRuntime, reconferirEmBreve } from "../../runtime/supervisor.js";
import * as twitchOAuth from "../../twitch/oauth.js";
import { query } from "../../db/index.js";
import { config } from "../../config/env.js";
import { destroySession, cookieOptions } from "../../lib/session.js";
import * as channels from "../../repos/channels.js";
import * as eventos from "../../repos/eventos.js";
import * as acessoBilling from "../../billing/access.js";
import { esquecer as esquecerRaid } from "../../domain/raid.js";

export const router = express.Router();

router.use("/api/painel", requireSession);

/** Tudo que o painel precisa pra desenhar a tela inicial, numa chamada so. */
router.get("/api/painel/status", async (req, res, next) => {
  try {
    const canalId = req.channelId;
    const [acesso, tokenInfo] = await Promise.all([acessoBilling.doCanal(canalId), channels.tokenStatus(canalId)]);

    // Estado vivo da conexao com a Twitch. Sem isso a streamer descobre que o
    // bot caiu quando o chefao para de apanhar no meio da live.
    const runtime = getRuntime(canalId);
    const runtimeStatus = runtime?.status?.() ?? null;

    res.json({
      ok: true,
      acesso,
      conexao: {
        ligado: Boolean(runtime),
        chat: runtimeStatus?.chat?.conectado ?? false,
        eventsub: runtimeStatus?.eventsub?.conectado ?? false,
        inscricoes: runtimeStatus?.eventsub?.inscricoes ?? {},
        ultimoErro: runtimeStatus?.chat?.ultimoErro ?? runtimeStatus?.eventsub?.ultimoErro ?? null,
      },
      overlaysConectados: contarOverlays(canalId),
      twitch: { precisaReconectar: Boolean(tokenInfo?.invalid_at), escopos: tokenInfo?.scopes ?? [] },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/api/painel/eventos", async (req, res, next) => {
  try {
    res.json({ ok: true, eventos: await eventos.recentes(req.channelId, req.query.limite) });
  } catch (err) {
    next(err);
  }
});

/** Trocar a URL secreta do overlay (se ela apareceu na live sem querer). */
router.post("/api/painel/overlay/novo-token", async (req, res, next) => {
  try {
    const token = await channels.rotateOverlayToken(req.channelId);
    reconferirEmBreve();
    res.json({ ok: true, overlayUrl: `${config.baseUrl}/overlay/${token}` });
  } catch (err) {
    next(err);
  }
});

/**
 * Excluir a conta - direito de exclusao da LGPD, e o unico jeito honesto de
 * oferecer isso e um botao, nao um e-mail que alguem precisa ler.
 *
 * Apaga em cascata canal, raids, golpes e assinatura; devolve o acesso a
 * Twitch revogando o token (as recompensas criadas pelo app ficam orfas na
 * Twitch e a streamer pode apaga-las; a partir da etapa 3 elas sao removidas
 * aqui antes do revoke); e derruba o runtime do canal.
 *
 * Exige digitar o proprio login como confirmacao: e irreversivel.
 */
router.post("/api/painel/conta/excluir", async (req, res, next) => {
  try {
    const canal = await channels.findById(req.channelId);
    if (String(req.body.confirmacao ?? "").trim().toLowerCase() !== canal.login) {
      return res.status(400).json({ ok: false, error: `Digite "${canal.login}" para confirmar a exclusão.` });
    }

    const runtime = getRuntime(canal.id);
    if (runtime) await runtime.parar();

    // Revoga antes de apagar: depois do delete nao existe mais token pra revogar.
    const token = await channels.getAccessToken(canal.id).catch(() => null);
    if (token) await twitchOAuth.revoke(token);

    esquecerRaid(canal.id);
    await query("delete from channels where id = $1", [canal.id]);

    await destroySession(req.cookies?.[config.session.cookieName]);
    res.clearCookie(config.session.cookieName, { ...cookieOptions, maxAge: undefined });

    reconferirEmBreve();
    console.log(`[conta] canal ${canal.login} excluido a pedido do dono`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
