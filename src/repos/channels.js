import { one, many, query, tx } from "../db/index.js";
import { encrypt, decrypt } from "../lib/secretBox.js";
import { randomToken, slugify } from "../lib/ids.js";
import * as twitchOAuth from "../twitch/oauth.js";

/**
 * Canal = cliente. Toda funcao daqui pra baixo recebe channelId e so mexe
 * no que e desse canal.
 */

const CAMPOS_PUBLICOS = "id, twitch_user_id, login, display_name, email, avatar_url, slug, overlay_token, settings, created_at";

export const findById = (channelId) => one(`select ${CAMPOS_PUBLICOS} from channels where id = $1`, [channelId]);
export const findBySlug = (slug) => one(`select ${CAMPOS_PUBLICOS} from channels where slug = $1`, [String(slug ?? "").toLowerCase()]);
export const findByLogin = (login) => one(`select ${CAMPOS_PUBLICOS} from channels where login = $1`, [String(login ?? "").toLowerCase()]);
export const findByOverlayToken = (token) => one(`select ${CAMPOS_PUBLICOS} from channels where overlay_token = $1`, [token]);

/** Slug livre a partir do login; se ja existir (canal apagado e recriado), numera. */
async function slugDisponivel(login) {
  const base = slugify(login);
  for (let i = 0; i < 50; i++) {
    const tentativa = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await findBySlug(tentativa))) return tentativa;
  }
  return `${base}-${randomToken(3)}`;
}

/**
 * Entrou com a Twitch: cria o canal na primeira vez, atualiza nome/foto nas
 * seguintes, e guarda os tokens cifrados. O trial comeca aqui - antes de
 * existir cobranca, quem entra ja pode usar.
 */
export async function upsertFromTwitch(perfil, tokens, { trialDays = 14 } = {}) {
  const existente = await one("select id from channels where twitch_user_id = $1", [perfil.twitchUserId]);
  const slug = existente ? undefined : await slugDisponivel(perfil.login);

  return tx(async (t) => {
    let channelId = existente?.id;

    if (channelId) {
      await t.query(
        `update channels set login = $2, display_name = $3, email = coalesce($4, email),
                avatar_url = $5, updated_at = now()
           where id = $1`,
        [channelId, perfil.login, perfil.displayName, perfil.email, perfil.avatarUrl]
      );
    } else {
      const { rows } = await t.query(
        `insert into channels (twitch_user_id, login, display_name, email, avatar_url, slug, overlay_token)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [perfil.twitchUserId, perfil.login, perfil.displayName, perfil.email, perfil.avatarUrl, slug, randomToken(24)]
      );
      channelId = rows[0].id;
      await t.query(
        `insert into subscriptions (channel_id, status, trial_ends_at)
         values ($1, 'trialing', now() + ($2 || ' days')::interval)`,
        [channelId, String(trialDays)]
      );
    }

    await t.query(
      `insert into channel_tokens (channel_id, access_token, refresh_token, scopes, expires_at, invalid_at, invalid_reason)
       values ($1, $2, $3, $4, $5, null, null)
       on conflict (channel_id) do update
         set access_token = excluded.access_token,
             refresh_token = excluded.refresh_token,
             scopes = excluded.scopes,
             expires_at = excluded.expires_at,
             invalid_at = null,
             invalid_reason = null,
             updated_at = now()`,
      [channelId, encrypt(tokens.accessToken), encrypt(tokens.refreshToken), tokens.scopes, tokens.expiresAt]
    );

    const { rows } = await t.query(`select ${CAMPOS_PUBLICOS} from channels where id = $1`, [channelId]);
    return { canal: rows[0], novo: !existente };
  });
}

/** Marca que a Twitch recusou o token: o painel pede pra reconectar. */
export async function markTokenInvalid(channelId, motivo) {
  await query(
    "update channel_tokens set invalid_at = now(), invalid_reason = $2, updated_at = now() where channel_id = $1",
    [channelId, String(motivo).slice(0, 300)]
  );
}

/**
 * Access token valido do canal, renovando sozinho quando esta perto de vencer.
 *
 * O token da Twitch dura ~4h: numa live de 6h ele vence no meio. Renovar com
 * 10 minutos de folga evita a corrida entre "vencer" e "usar". A Twitch troca
 * o refresh token junto, entao o novo precisa ser gravado sempre.
 *
 * Devolve null se a conta precisa ser reconectada (quem chama avisa a streamer).
 */
export async function getAccessToken(channelId, { margemMs = 10 * 60 * 1000 } = {}) {
  const linha = await one(
    "select access_token, refresh_token, scopes, expires_at, invalid_at from channel_tokens where channel_id = $1",
    [channelId]
  );
  if (!linha || linha.invalid_at) return null;

  const vencendo = !linha.expires_at || new Date(linha.expires_at).getTime() - Date.now() < margemMs;
  if (!vencendo) return decrypt(linha.access_token);

  try {
    const novos = await twitchOAuth.refreshToken(decrypt(linha.refresh_token));
    await query(
      `update channel_tokens
          set access_token = $2, refresh_token = $3, scopes = $4, expires_at = $5,
              invalid_at = null, invalid_reason = null, updated_at = now()
        where channel_id = $1`,
      [channelId, encrypt(novos.accessToken), encrypt(novos.refreshToken), novos.scopes, novos.expiresAt]
    );
    return novos.accessToken;
  } catch (err) {
    if (err.needsReauth) {
      await markTokenInvalid(channelId, err.message);
      console.warn(`[token] canal ${channelId} precisa reconectar: ${err.message}`);
      return null;
    }
    // Erro de rede/5xx: o token atual ainda pode servir, nao invalida por isso.
    console.error(`[token] falha temporaria ao renovar canal ${channelId}:`, err.message);
    return decrypt(linha.access_token);
  }
}

export const tokenStatus = (channelId) =>
  one("select scopes, expires_at, invalid_at, invalid_reason, updated_at from channel_tokens where channel_id = $1", [channelId]);

/** Canais que devem ter runtime ligado (EventSub + chat) agora. */
export const listarAtivos = () =>
  many(
    `select c.id, c.login, c.display_name, c.slug, c.overlay_token, s.status, s.trial_ends_at, s.grace_until
       from channels c
       join subscriptions s on s.channel_id = c.id
       left join channel_tokens t on t.channel_id = c.id
      where t.channel_id is not null and t.invalid_at is null
        and (s.status in ('active', 'trialing') or s.grace_until > now())
      order by c.created_at`
  );

export async function rotateOverlayToken(channelId) {
  const token = randomToken(24);
  await query("update channels set overlay_token = $2, updated_at = now() where id = $1", [channelId, token]);
  return token;
}
