import { one, query } from "../db/index.js";

export const get = (channelId) => one("select * from subscriptions where channel_id = $1", [channelId]);

/**
 * Atualiza a assinatura. Chamado pelo webhook do provedor de pagamento (ou
 * pelo painel de dono, no modo manual). Grava tambem o payload cru: quando
 * der divergencia com o provedor, e isso que explica o que aconteceu.
 */
export async function upsert(channelId, dados) {
  const { provider = "manual", externalId = null, plan = "basico", status, currentPeriodEnd = null, graceUntil = null, raw = {} } = dados;
  await query(
    `insert into subscriptions (channel_id, provider, external_id, plan, status, current_period_end, grace_until, raw, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())
     on conflict (channel_id) do update
       set provider = excluded.provider,
           external_id = coalesce(excluded.external_id, subscriptions.external_id),
           plan = excluded.plan,
           status = excluded.status,
           current_period_end = excluded.current_period_end,
           grace_until = excluded.grace_until,
           raw = excluded.raw,
           updated_at = now()`,
    [channelId, provider, externalId, plan, status, currentPeriodEnd, graceUntil, JSON.stringify(raw)]
  );
  return get(channelId);
}

export const findByExternalId = (provider, externalId) =>
  one("select * from subscriptions where provider = $1 and external_id = $2", [provider, externalId]);
