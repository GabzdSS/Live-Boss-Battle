import express from "express";
import { config } from "../../config/env.js";
import { one, query } from "../../db/index.js";
import { createSession, cookieOptions } from "../../lib/session.js";
import { randomToken, slugify } from "../../lib/ids.js";
import { encrypt } from "../../lib/secretBox.js";
import { SCOPES } from "../../twitch/oauth.js";

/**
 * Rotas que so existem fora de producao.
 *
 * Elas vivem DENTRO do servidor de proposito: no modo dev o banco e PGlite,
 * que aceita um processo por vez. Um script separado mexendo no mesmo diretorio
 * enquanto o servidor roda grava no disco mas o servidor nao enxerga (ele tem
 * a propria copia em memoria) - dois minutos de confusao garantidos.
 */
export const router = express.Router();

/**
 * Cria (ou reaproveita) um canal falso, ja logado. Nao conecta na Twitch: o
 * token e falso, entao o runtime marca "precisa reconectar" na primeira
 * tentativa - e o modo de teste do painel e o caminho pra jogar com ele.
 */
router.get("/dev/canal-de-teste", async (req, res, next) => {
  try {
    const login = String(req.query.login || "canal_teste").toLowerCase();
    let canal = await one("select * from channels where login = $1", [login]);

    if (!canal) {
      canal = await one(
        `insert into channels (twitch_user_id, login, display_name, email, slug, overlay_token)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [`teste-${randomToken(6)}`, login, login, `${login}@exemplo.test`, slugify(login), randomToken(24)]
      );
      await query(
        "insert into subscriptions (channel_id, status, trial_ends_at) values ($1, 'trialing', now() + interval '14 days')",
        [canal.id]
      );
      await query(
        `insert into channel_tokens (channel_id, access_token, refresh_token, scopes, expires_at)
         values ($1, $2, $3, $4, now() + interval '4 hours')`,
        [canal.id, encrypt("token-falso"), encrypt("refresh-falso"), SCOPES]
      );
      console.log(`[dev] canal de teste criado: ${login}`);
    }

    const sessao = await createSession(canal.id, { userAgent: req.headers["user-agent"] });
    res.cookie(config.session.cookieName, sessao.cookie, cookieOptions);
    res.redirect("/painel");
  } catch (err) {
    next(err);
  }
});

/** Transforma um cookie de sessao ja existente em login no navegador. */
router.get("/dev/entrar", (req, res) => {
  res.cookie(config.session.cookieName, String(req.query.cookie ?? ""), cookieOptions);
  res.redirect("/painel");
});
