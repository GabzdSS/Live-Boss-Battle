import crypto from "crypto";
import { config } from "../config/env.js";
import { one, query } from "../db/index.js";
import { safeEqual } from "./secretBox.js";
import { randomToken } from "./ids.js";

/**
 * Sessao do painel: id aleatorio guardado no banco + cookie assinado.
 *
 * O cookie leva "<id>.<assinatura>". A assinatura impede que alguem invente
 * um id valido por forca bruta; o banco permite revogar (logout, cancelamento,
 * troca de senha) sem esperar cookie expirar.
 */

const MS_DIA = 24 * 60 * 60 * 1000;

function sign(valor) {
  return crypto.createHmac("sha256", config.secretKey).update(valor).digest("base64url");
}

export async function createSession(channelId, { userAgent } = {}) {
  const id = randomToken(32);
  const expiresAt = new Date(Date.now() + config.session.maxAgeDays * MS_DIA);
  await query("insert into sessions (id, channel_id, user_agent, expires_at) values ($1, $2, $3, $4)", [
    id,
    channelId,
    userAgent?.slice(0, 300) ?? null,
    expiresAt,
  ]);
  return { id, cookie: `${id}.${sign(id)}`, expiresAt };
}

export async function readSession(cookieValue) {
  if (!cookieValue) return null;
  const [id, assinatura] = String(cookieValue).split(".");
  if (!id || !assinatura || !safeEqual(assinatura, sign(id))) return null;

  const sessao = await one(
    `select s.channel_id, s.expires_at, c.login, c.display_name, c.slug, c.avatar_url
       from sessions s join channels c on c.id = s.channel_id
      where s.id = $1 and s.expires_at > now()`,
    [id]
  );
  return sessao ? { id, channelId: sessao.channel_id, ...sessao } : null;
}

export async function destroySession(cookieValue) {
  const [id] = String(cookieValue ?? "").split(".");
  if (id) await query("delete from sessions where id = $1", [id]);
}

/** Limpeza periodica: sessao vencida e estado de OAuth abandonado. */
export async function pruneExpired() {
  await query("delete from sessions where expires_at < now()");
  await query("delete from oauth_states where created_at < now() - interval '15 minutes'");
}

export const cookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: config.baseUrl.startsWith("https://"),
  maxAge: config.session.maxAgeDays * MS_DIA,
  path: "/",
};
