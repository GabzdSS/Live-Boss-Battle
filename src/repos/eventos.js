import { many, query } from "../db/index.js";

/** Feed do painel: o que a Twitch mandou e o que o jogo fez com isso. */

export async function registrar(channelId, kind, payload) {
  await query("insert into channel_events (channel_id, kind, payload) values ($1, $2, $3)", [channelId, kind, JSON.stringify(payload)]);
}

export const recentes = (channelId, limite = 50) =>
  many("select kind, payload, created_at from channel_events where channel_id = $1 order by created_at desc limit $2", [
    channelId,
    Math.min(Math.max(Number(limite) || 50, 1), 200),
  ]);
