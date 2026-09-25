import { test, before, after } from "node:test";
import assert from "node:assert/strict";

// Banco so na memoria: o teste nunca toca no data/pg de desenvolvimento.
process.env.PGLITE_DIR = "memory://";
delete process.env.DATABASE_URL;

const { migrate } = await import("../src/db/migrate.js");
const { query, one, close } = await import("../src/db/index.js");
const { raidDoCanal, esquecer, gatilhoDeTeste } = await import("../src/domain/raid.js");

let n = 0;
async function novoCanal(ajustes = {}) {
  n += 1;
  const canal = await one(
    `insert into channels (twitch_user_id, login, display_name, slug, overlay_token)
     values ($1, $2, $2, $2, $3) returning id`,
    [`tw-${n}`, `canal${n}`, `tok-${n}`]
  );
  await query("insert into raid_settings (channel_id) values ($1)", [canal.id]);
  for (const [coluna, valor] of Object.entries(ajustes)) {
    await query(`update raid_settings set ${coluna} = $2 where channel_id = $1`, [canal.id, valor]);
  }
  const emitidos = [];
  const gerente = raidDoCanal(canal.id, { emitir: (_id, evento, payload) => emitidos.push({ evento, payload }), sortear: () => 0.99 });
  return { id: canal.id, gerente, emitidos };
}

const ataque = (nome = "ana") => gatilhoDeTeste({ nome, recompensa: "ataque" });
const cheer = (bits, nome = "bia") => gatilhoDeTeste({ nome, bits });

before(async () => {
  await migrate({ silent: true });
});
after(async () => {
  await close();
});

test("iniciar cria a raid com a vida cheia e so deixa uma por canal", async () => {
  const { gerente, emitidos } = await novoCanal();
  const estado = await gerente.iniciar();
  assert.equal(estado.status, "rodando");
  assert.equal(estado.vida, 5000);
  assert.equal(estado.recompensas.length, 2);
  assert.ok(estado.restanteMs > 590_000);
  assert.equal(emitidos.at(-1).evento, "raid:estado");
  await assert.rejects(gerente.iniciar(), { codigo: "ja-tem-raid" });
});

test("golpes descontam vida, entram no ranking, e o mesmo evento nao conta duas vezes", async () => {
  const { id, gerente } = await novoCanal();
  await gerente.iniciar();
  const g = ataque("ana");
  assert.equal((await gerente.golpear(g)).danoEfetivo, 10);
  assert.equal((await gerente.golpear(g)).motivo, "duplicado");
  await gerente.golpear(cheer(100, "bia"));

  const s = gerente.snapshot();
  assert.equal(s.vida, 5000 - 10 - 100);
  assert.deepEqual(s.ranking.map((l) => [l.nome, l.dano]), [["bia", 100], ["ana", 10]]);
  const banco = await one("select vida from raids where channel_id = $1", [id]);
  assert.equal(banco.vida, s.vida);
});

test("sem raid, o golpe e recusado com motivo", async () => {
  const { gerente } = await novoCanal();
  assert.equal((await gerente.golpear(ataque())).motivo, "sem-raid");
});

test("pausa: congela o tempo, recusa pontos, aceita bits", async () => {
  const { gerente } = await novoCanal();
  await gerente.iniciar();
  const p = await gerente.pausar();
  assert.equal(p.ok, true);
  assert.equal(gerente.snapshot().status, "pausada");
  const restante = gerente.snapshot().restanteMs;

  assert.equal((await gerente.golpear(ataque())).motivo, "pausada");
  assert.equal((await gerente.golpear(cheer(5))).ok, true);

  await new Promise((r) => setTimeout(r, 120));
  assert.equal(gerente.snapshot().restanteMs, restante); // parado de verdade
  assert.equal((await gerente.retomar()).ok, true);
  assert.ok(Math.abs(gerente.snapshot().restanteMs - restante) < 200);
  assert.equal((await gerente.pausar()).ok, true);
  assert.equal((await gerente.pausar()).motivo, "ja-pausada");
});

test("vitoria: golpe final zera a vida, anuncia ranking e libera o canal", async () => {
  const { id, gerente, emitidos } = await novoCanal({ vida: 100 });
  await gerente.iniciar();
  await gerente.golpear(cheer(40, "ana"));
  const r = await gerente.golpear(cheer(500, "bia"));
  assert.equal(r.derrotado, true);
  assert.equal(r.danoEfetivo, 60);

  const fim = emitidos.find((e) => e.evento === "raid:fim").payload;
  assert.equal(fim.status, "vitoria");
  assert.equal(fim.golpeFinal.nome, "bia");
  assert.deepEqual(fim.ranking.map((l) => [l.nome, l.dano]), [["bia", 60], ["ana", 40]]);
  assert.equal(gerente.snapshot().status, "ociosa");
  assert.equal((await one("select status from raids where channel_id = $1", [id])).status, "vitoria");
  // canal livre pra outra raid
  assert.equal((await gerente.iniciar()).status, "rodando");
});

test("fases: cruzar 50% e 25% emite a troca de fase", async () => {
  const { gerente, emitidos } = await novoCanal({ vida: 1000 });
  await gerente.iniciar();
  await gerente.golpear(cheer(800));
  assert.deepEqual(emitidos.filter((e) => e.evento === "raid:fase").map((e) => e.payload.fase), [1, 2]);
  assert.equal(gerente.snapshot().fase, 2);
});

test("tempo acabou: o chefao foge", async () => {
  const { id, gerente, emitidos } = await novoCanal({ duracao_segundos: 1 });
  await gerente.iniciar();
  await new Promise((r) => setTimeout(r, 1400));
  assert.equal(emitidos.find((e) => e.evento === "raid:fim")?.payload.status, "fuga");
  assert.equal((await one("select status from raids where channel_id = $1", [id])).status, "fuga");
});

test("encerrar pelo painel cancela", async () => {
  const { gerente } = await novoCanal();
  await gerente.iniciar();
  const r = await gerente.encerrar();
  assert.equal(r.final.status, "cancelada");
  assert.equal((await gerente.encerrar()).motivo, "sem-raid");
});

test("reinicio do servidor: a raid volta com vida e ranking", async () => {
  const { id, gerente } = await novoCanal();
  await gerente.iniciar();
  await gerente.golpear(cheer(70, "ana"));
  await gerente.golpear(ataque("bia"));

  esquecer(id); // simula o processo morrendo
  const novo = raidDoCanal(id, { emitir: () => {} });
  await novo.carregar();
  const s = novo.snapshot();
  assert.equal(s.status, "rodando");
  assert.equal(s.vida, 5000 - 80);
  assert.deepEqual(s.ranking.map((l) => [l.nome, l.dano]), [["ana", 70], ["bia", 10]]);
  assert.ok(s.restanteMs > 590_000);
});

test("reinicio depois do prazo: o chefao fugiu enquanto o servidor estava fora", async () => {
  const { id, gerente } = await novoCanal();
  await gerente.iniciar();
  await query("update raids set ends_at = now() - interval '1 minute' where channel_id = $1", [id]);

  esquecer(id);
  const emitidos = [];
  const novo = raidDoCanal(id, { emitir: (_c, evento, payload) => emitidos.push({ evento, payload }) });
  await novo.carregar();
  assert.equal(novo.snapshot().status, "ociosa");
  assert.equal(emitidos.find((e) => e.evento === "raid:fim").payload.status, "fuga");
});

test("50 golpes ao mesmo tempo: nenhum se perde nem le vida velha", async () => {
  const { id, gerente } = await novoCanal();
  await gerente.iniciar();
  const resultados = await Promise.all(Array.from({ length: 50 }, (_, i) => gerente.golpear(ataque(`v${i}`))));
  assert.ok(resultados.every((r) => r.ok));
  assert.equal(gerente.snapshot().vida, 5000 - 500);
  assert.equal((await one("select vida from raids where channel_id = $1", [id])).vida, 4500);
  assert.equal((await one("select count(*)::int as n from raid_hits where channel_id = $1", [id])).n, 50);
});

test("resgate da Twitch: so a nossa recompensa vira golpe", async () => {
  const { id, gerente } = await novoCanal();
  await gerente.pronto();
  // listarRecompensas cria as padrao; a etapa 3 grava o id da Twitch nelas
  const { listarRecompensas } = await import("../src/repos/raidConfig.js");
  await listarRecompensas(id);
  await query("update raid_rewards set twitch_reward_id = $2 where channel_id = $1 and chave = 'ataque-forte'", [id, `rw-${id}`]);
  await gerente.iniciar();

  const base = { origem: "resgate", userId: "900", login: "caio", username: "Caio" };
  const nossa = await gerente.golpear({ ...base, ref: "resgate:1", rewardId: `rw-${id}` });
  assert.equal(nossa.danoEfetivo, 120);
  const alheia = await gerente.golpear({ ...base, ref: "resgate:2", rewardId: "hidratar" });
  assert.equal(alheia.motivo, "nao-e-golpe");
});
