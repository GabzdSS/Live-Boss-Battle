import express from "express";
import { config } from "../../config/env.js";
import { query, one } from "../../db/index.js";
import { randomToken } from "../../lib/ids.js";
import { createSession, destroySession, cookieOptions } from "../../lib/session.js";
import * as twitchOAuth from "../../twitch/oauth.js";
import * as channels from "../../repos/channels.js";
import { reconferirEmBreve } from "../../runtime/supervisor.js";

export const router = express.Router();

/**
 * "Entrar com a Twitch" - unico jeito de entrar no produto. Nao existe senha
 * nossa pra vazar, e a autorizacao ja traz de brinde o que o app precisa pra
 * funcionar no canal (recompensas, cheers e chat).
 */
router.get("/auth/twitch", async (req, res) => {
  const state = randomToken(16);
  const voltar = typeof req.query.voltar === "string" && req.query.voltar.startsWith("/") ? req.query.voltar : "/painel";
  await query("insert into oauth_states (state, redirect_to) values ($1, $2)", [state, voltar]);
  res.redirect(twitchOAuth.buildAuthUrl({ state, forceVerify: req.query.trocar === "1" }));
});

router.get("/auth/twitch/callback", async (req, res, next) => {
  try {
    const { code, state, error, error_description: descricao } = req.query;

    if (error) {
      // Clicou "Cancelar" na tela da Twitch - nao e falha nossa.
      return res.redirect(`/entrar?erro=${encodeURIComponent(descricao || error)}`);
    }

    // O state amarra o retorno ao pedido que saiu daqui: sem ele, qualquer
    // site poderia empurrar um callback e logar a vitima numa conta alheia.
    const guardado = await one("delete from oauth_states where state = $1 returning redirect_to, created_at", [state]);
    if (!guardado) return res.redirect("/entrar?erro=" + encodeURIComponent("Sessão de login expirou. Tenta de novo."));

    const tokens = await twitchOAuth.exchangeCode(String(code));
    const perfil = await twitchOAuth.getCurrentUser(tokens.accessToken);


    const { canal, novo } = await channels.upsertFromTwitch(perfil, tokens);

    const sessao = await createSession(canal.id, { userAgent: req.headers["user-agent"] });
    res.cookie(config.session.cookieName, sessao.cookie, cookieOptions);

    // Sem isso, quem acabou de entrar (ou de reconectar a conta) esperaria ate
    // a proxima rodada do supervisor pro canal comecar a funcionar.
    reconferirEmBreve();

    console.log(`[auth] ${novo ? "canal novo" : "login"}: ${canal.login}`);
    res.redirect(novo ? "/painel?bemvindo=1" : guardado.redirect_to || "/painel");
  } catch (err) {
    next(err);
  }
});

router.post("/auth/sair", async (req, res) => {
  await destroySession(req.cookies?.[config.session.cookieName]);
  res.clearCookie(config.session.cookieName, { ...cookieOptions, maxAge: undefined });
  res.json({ ok: true });
});

/** Quem sou eu - o painel chama isso ao abrir. */
router.get("/api/eu", async (req, res) => {
  if (!req.session) return res.json({ autenticado: false });
  const canal = await channels.findById(req.channelId);
  const token = await channels.tokenStatus(req.channelId);
  res.json({
    autenticado: true,
    canal: {
      login: canal.login,
      displayName: canal.display_name,
      slug: canal.slug,
      avatarUrl: canal.avatar_url,
      overlayUrl: `${config.baseUrl}/overlay/${canal.overlay_token}`,
      paginaUrl: `${config.baseUrl}/c/${canal.slug}`,
    },
    twitch: {
      escopos: token?.scopes ?? [],
      // Escopo novo numa versao futura (ex.: VIP como premio) aparece aqui
      // como faltando, e o painel pede pra reconectar em vez de falhar calado.
      escoposFaltando: twitchOAuth.SCOPES.filter((e) => !(token?.scopes ?? []).includes(e)),
      precisaReconectar: Boolean(token?.invalid_at),
      motivo: token?.invalid_reason ?? null,
    },
  });
});
