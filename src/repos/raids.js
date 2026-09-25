import { one, many, tx } from "../db/index.js";

/** Raids e golpes. Toda funcao recebe channelId primeiro, como no resto do app. */

const paraRaid = (l) =>
  l && {
    id: l.id,
    channelId: l.channel_id,
    status: l.status,
    config: l.config,
    vidaMax: l.vida_max,
    vida: l.vida,
    fase: l.fase,
    startedAt: l.started_at,
    endsAt: l.ends_at,
    pausedRemainingMs: l.paused_remaining_ms,
    endedAt: l.ended_at,
    isTest: l.is_test,
  };

export const ativa = async (channelId) =>
  paraRaid(await one("select * from raids where channel_id = $1 and status in ('rodando', 'pausada')", [channelId]));

/** Todas as raids em andamento, de todos os canais - so o arranque do servidor usa. */
export const todasAtivas = async () => (await many("select * from raids where status in ('rodando', 'pausada')")).map(paraRaid);

export async function criar(channelId, { config, vidaMax, endsAt, isTest }) {
  // O indice unico parcial garante uma raid ativa por canal; aqui so traduz o erro.
  try {
    return paraRaid(
      await one(
        `insert into raids (channel_id, status, config, vida_max, vida, fase, ends_at, is_test)
         values ($1, 'rodando', $2, $3, $3, 0, $4, $5) returning *`,
        [channelId, JSON.stringify(config), vidaMax, endsAt, Boolean(isTest)]
      )
    );
  } catch (err) {
    if (err.code === "23505" || /raids_uma_ativa_por_canal/.test(err.message)) {
      const erro = new Error("Já existe uma raid em andamento neste canal.");
      erro.codigo = "ja-tem-raid";
      throw erro;
    }
    throw err;
  }
}

export const pausar = async (channelId, raidId, restanteMs) =>
  paraRaid(
    await one(
      `update raids set status = 'pausada', ends_at = null, paused_remaining_ms = $3
        where channel_id = $1 and id = $2 and status = 'rodando' returning *`,
      [channelId, raidId, Math.max(0, Math.round(restanteMs))]
    )
  );

export const retomar = async (channelId, raidId, endsAt) =>
  paraRaid(
    await one(
      `update raids set status = 'rodando', ends_at = $3, paused_remaining_ms = null
        where channel_id = $1 and id = $2 and status = 'pausada' returning *`,
      [channelId, raidId, endsAt]
    )
  );

export const finalizar = async (channelId, raidId, status) =>
  paraRaid(
    await one(
      `update raids set status = $3, ended_at = now(), ends_at = null
        where channel_id = $1 and id = $2 and status in ('rodando', 'pausada') returning *`,
      [channelId, raidId, status]
    )
  );

/**
 * Grava o golpe e a vida nova juntos. Se o mesmo evento ja virou golpe
 * (source_ref repetido), nada muda e devolve { duplicado: true }.
 */
export async function registrarGolpe(channelId, raidId, golpe, { vida, fase }) {
  return tx(async (t) => {
    const { rows } = await t.query(
      `insert into raid_hits (raid_id, channel_id, jogador, login, display_name, origem, source_ref, bits, recompensa,
                              dano_base, dano_final, dano_efetivo, critico, fase)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (raid_id, source_ref) do nothing
       returning id, created_at`,
      [
        raidId,
        channelId,
        golpe.jogador,
        golpe.login,
        golpe.nome,
        golpe.origem,
        golpe.ref,
        golpe.bits ?? null,
        golpe.recompensa ?? null,
        golpe.danoBase,
        golpe.danoFinal,
        golpe.danoEfetivo,
        golpe.critico,
        golpe.fase,
      ]
    );
    if (!rows.length) return { duplicado: true };
    await t.query("update raids set vida = $3, fase = $4 where channel_id = $1 and id = $2", [channelId, raidId, vida, fase]);
    return { duplicado: false, id: rows[0].id, em: rows[0].created_at };
  });
}

/** Ranking completo da raid, direto do banco (usado ao restaurar e no fim). */
export const rankingDaRaid = async (channelId, raidId) =>
  (
    await many(
      `select jogador, max(display_name) as nome, sum(dano_efetivo)::int as dano, count(*)::int as golpes
         from raid_hits where channel_id = $1 and raid_id = $2 and jogador is not null
        group by jogador`,
      [channelId, raidId]
    )
  ).map((l) => ({ jogador: l.jogador, nome: l.nome, dano: l.dano, golpes: l.golpes }));

/** Quem deu o golpe final (o que zerou a vida). */
export const golpeFinal = (channelId, raidId) =>
  one(
    `select display_name as nome, jogador, dano_efetivo as dano from raid_hits
      where channel_id = $1 and raid_id = $2 order by id desc limit 1`,
    [channelId, raidId]
  );
