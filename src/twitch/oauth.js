import { config } from "../config/env.js";

const ID_BASE = "https://id.twitch.tv/oauth2";
const HELIX = "https://api.twitch.tv/helix";

/**
 * Escopos que a streamer autoriza ao entrar. Cada um existe por um motivo:
 *
 *   channel:manage:redemptions  criar as recompensas "Ataque"/"Ataque Forte",
 *                               ligar/desligar junto com a raid, marcar resgate
 *                               como concluido ou REEMBOLSAR (status CANCELED).
 *                               Tambem cobre ler os resgates pelo EventSub.
 *   bits:read                   cheers via EventSub (dano por bit)
 *   user:read:email             contato de cobranca e aviso de token vencido
 *   chat:read / chat:edit       o bot anuncia a raid e o ranking com a conta dela
 *
 * Pedir menos e melhor que pedir mais: cada escopo a mais e uma pessoa a mais
 * desistindo na tela de autorizacao.
 */
export const SCOPES = ["channel:manage:redemptions", "bits:read", "user:read:email", "chat:read", "chat:edit"];

export function buildAuthUrl({ state, forceVerify = false, scopes = SCOPES }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.twitch.clientId,
    redirect_uri: config.twitch.redirectUri,
    scope: scopes.join(" "),
    state,
  });
  // force_verify faz a Twitch perguntar de novo mesmo pra quem ja autorizou -
  // util pra trocar de conta sem precisar deslogar da Twitch inteira.
  if (forceVerify) params.set("force_verify", "true");
  return `${ID_BASE}/authorize?${params}`;
}

async function postToken(body) {
  const res = await fetch(`${ID_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.twitch.clientId, client_secret: config.twitch.clientSecret, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Twitch OAuth ${res.status}: ${data.message || JSON.stringify(data)}`);
    err.status = res.status;
    // 400/401 aqui quase sempre significa refresh token morto: a streamer
    // precisa reconectar. Quem chama usa isso pra decidir avisar ou so tentar de novo.
    err.needsReauth = res.status === 400 || res.status === 401;
    throw err;
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    scopes: data.scope ?? [],
    expiresAt: new Date(Date.now() + (data.expires_in ?? 14400) * 1000),
  };
}

export const exchangeCode = (code) =>
  postToken({ grant_type: "authorization_code", code, redirect_uri: config.twitch.redirectUri });

export const refreshToken = (token) => postToken({ grant_type: "refresh_token", refresh_token: token });

/** Dados da conta dona do token (id, login, display, email, foto). */
export async function getCurrentUser(accessToken) {
  const res = await fetch(`${HELIX}/users`, {
    headers: { "Client-Id": config.twitch.clientId, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Twitch /users ${res.status}: ${await res.text()}`);
  const { data } = await res.json();
  const user = data?.[0];
  if (!user) throw new Error("Twitch nao devolveu nenhum usuario pra esse token");
  return {
    twitchUserId: user.id,
    login: user.login,
    displayName: user.display_name || user.login,
    email: user.email ?? null,
    avatarUrl: user.profile_image_url ?? null,
  };
}

/**
 * Resolve logins em ids da Twitch (ate 100 por chamada).
 *
 * Usado quando so temos o nome (golpe simulado pelo painel com um viewer de
 * verdade). O id e o que sobrevive a troca de nick.
 */
export async function getUsersByLogin(accessToken, logins) {
  const lista = [...new Set(logins.map((l) => String(l).toLowerCase()))].filter(Boolean).slice(0, 100);
  if (!lista.length) return [];

  const params = new URLSearchParams();
  for (const login of lista) params.append("login", login);

  const res = await fetch(`${HELIX}/users?${params}`, {
    headers: { "Client-Id": config.twitch.clientId, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Twitch /users ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { data } = await res.json();
  return (data ?? []).map((u) => ({
    twitchUserId: u.id,
    login: u.login,
    displayName: u.display_name || u.login,
    avatarUrl: u.profile_image_url ?? null,
  }));
}

/** Confere se o token ainda vale e quais escopos tem. Devolve null se morreu. */
export async function validate(accessToken) {
  const res = await fetch(`${ID_BASE}/validate`, { headers: { Authorization: `OAuth ${accessToken}` } });
  if (!res.ok) return null;
  const data = await res.json();
  return { login: data.login, userId: data.user_id, scopes: data.scopes ?? [], expiresIn: data.expires_in };
}

/** Usado quando a streamer cancela/apaga a conta: devolve o acesso pra ela. */
export async function revoke(accessToken) {
  await fetch(`${ID_BASE}/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.twitch.clientId, token: accessToken }),
  }).catch(() => {});
}
