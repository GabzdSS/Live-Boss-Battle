import { one, many, query, tx } from "../db/index.js";

/**
 * Configuracao do chefao e das recompensas de um canal.
 *
 * Quem nunca configurou nada recebe os padroes gravados na primeira leitura:
 * o painel e o modo de teste funcionam desde o primeiro minuto, antes da
 * streamer mexer em qualquer campo.
 */

export const RECOMPENSAS_PADRAO = [
  { chave: "ataque", titulo: "Ataque", custo: 100, dano: 10 },
  { chave: "ataque-forte", titulo: "Ataque Forte", custo: 1000, dano: 120 },
];

const paraConfig = (linha) => ({
  bossNome: linha.boss_nome,
  vida: linha.vida,
  duracaoSegundos: linha.duracao_segundos,
  danoPorBit: Number(linha.dano_por_bit),
  chanceCritico: Number(linha.chance_critico),
  multiplicadorCritico: Number(linha.multiplicador_critico),
  fases: linha.fases,
});

const paraRecompensa = (linha) => ({
  chave: linha.chave,
  titulo: linha.titulo,
  custo: linha.custo,
  dano: linha.dano,
  twitchRewardId: linha.twitch_reward_id,
  cooldownSegundos: linha.cooldown_segundos,
});

export async function obter(channelId) {
  await query("insert into raid_settings (channel_id) values ($1) on conflict (channel_id) do nothing", [channelId]);
  return paraConfig(await one("select * from raid_settings where channel_id = $1", [channelId]));
}

/** Recebe uma config ja validada (boss.validarConfig). */
export async function salvar(channelId, c) {
  await query(
    `insert into raid_settings (channel_id, boss_nome, vida, duracao_segundos, dano_por_bit, chance_critico, multiplicador_critico, fases, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())
     on conflict (channel_id) do update set
       boss_nome = excluded.boss_nome, vida = excluded.vida, duracao_segundos = excluded.duracao_segundos,
       dano_por_bit = excluded.dano_por_bit, chance_critico = excluded.chance_critico,
       multiplicador_critico = excluded.multiplicador_critico, fases = excluded.fases, updated_at = now()`,
    [channelId, c.bossNome, c.vida, c.duracaoSegundos, c.danoPorBit, c.chanceCritico, c.multiplicadorCritico, JSON.stringify(c.fases)]
  );
  return obter(channelId);
}

export async function listarRecompensas(channelId) {
  const linhas = await many("select * from raid_rewards where channel_id = $1 order by custo", [channelId]);
  if (linhas.length) return linhas.map(paraRecompensa);

  await tx(async (t) => {
    for (const r of RECOMPENSAS_PADRAO) {
      await t.query(
        `insert into raid_rewards (channel_id, chave, titulo, custo, dano) values ($1, $2, $3, $4, $5)
         on conflict (channel_id, chave) do nothing`,
        [channelId, r.chave, r.titulo, r.custo, r.dano]
      );
    }
  });
  return (await many("select * from raid_rewards where channel_id = $1 order by custo", [channelId])).map(paraRecompensa);
}

/** Qual das nossas recompensas e essa, pelo id que a Twitch manda no resgate. */
export async function recompensaPorTwitchId(channelId, twitchRewardId) {
  if (!twitchRewardId) return null;
  const linha = await one("select * from raid_rewards where channel_id = $1 and twitch_reward_id = $2", [channelId, twitchRewardId]);
  return linha ? paraRecompensa(linha) : null;
}
