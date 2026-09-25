import { test } from "node:test";
import assert from "node:assert/strict";
import { aplicarGolpe, faseDe, validarConfig, montarRanking, FASES_PADRAO } from "../src/domain/boss.js";

const config = {
  danoPorBit: 1,
  chanceCritico: 0.1,
  multiplicadorCritico: 2,
  fases: FASES_PADRAO,
  recompensas: { ataque: { dano: 10 }, "ataque-forte": { dano: 120 } },
};
const cheio = { vida: 1000, vidaMax: 1000, fase: 0 };
const semSorte = () => 0.99; // nunca critica
const sempreSorte = () => 0; // sempre critica

test("recompensa causa o dano fixo configurado", () => {
  const r = aplicarGolpe(cheio, config, { tipo: "recompensa", chave: "ataque" }, semSorte);
  assert.equal(r.ok, true);
  assert.equal(r.resultado.danoEfetivo, 10);
  assert.equal(r.estado.vida, 990);
  assert.deepEqual(r.eventos.map((e) => e.tipo), ["golpe"]);
});

test("recompensa nunca critica, mesmo com sorte", () => {
  const r = aplicarGolpe(cheio, config, { tipo: "recompensa", chave: "ataque" }, sempreSorte);
  assert.equal(r.resultado.critico, false);
  assert.equal(r.resultado.danoFinal, 10);
});

test("bits: dano proporcional, e o critico multiplica", () => {
  const normal = aplicarGolpe(cheio, config, { tipo: "bits", bits: 100 }, semSorte);
  assert.equal(normal.resultado.danoFinal, 100);
  assert.equal(normal.resultado.critico, false);

  const critico = aplicarGolpe(cheio, config, { tipo: "bits", bits: 100 }, sempreSorte);
  assert.equal(critico.resultado.critico, true);
  assert.equal(critico.resultado.danoFinal, 200);
});

test("chance de critico respeita o limiar do sorteio", () => {
  assert.equal(aplicarGolpe(cheio, config, { tipo: "bits", bits: 10 }, () => 0.0999).resultado.critico, true);
  assert.equal(aplicarGolpe(cheio, config, { tipo: "bits", bits: 10 }, () => 0.1).resultado.critico, false);
  const semCritico = { ...config, chanceCritico: 0 };
  assert.equal(aplicarGolpe(cheio, semCritico, { tipo: "bits", bits: 10 }, () => 0).resultado.critico, false);
});

test("armadura da fase ATUAL reduz o dano (minimo 1)", () => {
  const fase2 = { vida: 400, vidaMax: 1000, fase: 1 }; // armadura 0.2
  assert.equal(aplicarGolpe(fase2, config, { tipo: "bits", bits: 100 }, semSorte).resultado.danoFinal, 80);
  const fase3 = { vida: 200, vidaMax: 1000, fase: 2 }; // armadura 0.4
  assert.equal(aplicarGolpe(fase3, config, { tipo: "bits", bits: 1 }, semSorte).resultado.danoFinal, 1);
});

test("exatamente 50% ja e a segunda fase", () => {
  assert.equal(faseDe(501, 1000, FASES_PADRAO), 0);
  assert.equal(faseDe(500, 1000, FASES_PADRAO), 1);
  assert.equal(faseDe(250, 1000, FASES_PADRAO), 2);
  assert.equal(faseDe(0, 1000, FASES_PADRAO), 2);
});

test("golpe que atravessa duas fases emite as duas, em ordem", () => {
  const r = aplicarGolpe({ vida: 600, vidaMax: 1000, fase: 0 }, config, { tipo: "bits", bits: 400 }, semSorte);
  assert.equal(r.estado.vida, 200);
  assert.equal(r.estado.fase, 2);
  assert.deepEqual(
    r.eventos.filter((e) => e.tipo === "fase").map((e) => e.fase),
    [1, 2]
  );
  // armadura aplicada foi a da fase em que o golpe COMECOU
  assert.equal(r.resultado.armadura, 0);
});

test("golpe final: dano efetivo e so a vida que faltava, e derrota", () => {
  const r = aplicarGolpe({ vida: 30, vidaMax: 1000, fase: 2 }, config, { tipo: "bits", bits: 5000 }, semSorte);
  assert.equal(r.resultado.danoFinal, 3000);
  assert.equal(r.resultado.danoEfetivo, 30);
  assert.equal(r.estado.vida, 0);
  assert.equal(r.eventos.at(-1).tipo, "derrotado");
  assert.equal(aplicarGolpe(r.estado, config, { tipo: "bits", bits: 1 }).motivo, "ja-derrotado");
});

test("golpes invalidos sao recusados sem mexer na vida", () => {
  assert.equal(aplicarGolpe(cheio, config, { tipo: "recompensa", chave: "nao-existe" }).motivo, "recompensa-desconhecida");
  assert.equal(aplicarGolpe(cheio, config, { tipo: "bits", bits: 0 }).motivo, "bits-invalido");
  assert.equal(aplicarGolpe(cheio, { ...config, danoPorBit: 0 }, { tipo: "bits", bits: 10 }, semSorte).motivo, "sem-dano");
});

test("ranking soma por jogador, ignora anonimo e ordena por dano", () => {
  const ranking = montarRanking([
    { jogador: "1", nome: "Ana", danoEfetivo: 50 },
    { jogador: "2", nome: "Bia", danoEfetivo: 70 },
    { jogador: "1", nome: "Ana", danoEfetivo: 30 },
    { jogador: null, nome: "Anônimo", danoEfetivo: 999 },
  ]);
  assert.deepEqual(ranking.map((l) => [l.nome, l.dano, l.golpes]), [["Ana", 80, 2], ["Bia", 70, 1]]);
});

test("validarConfig aceita o padrao e explica o que esta errado", () => {
  const ok = validarConfig({ bossNome: "  Dragão ", vida: 5000, duracaoSegundos: 600, danoPorBit: 1, chanceCritico: 0.1, multiplicadorCritico: 2 });
  assert.equal(ok.config.bossNome, "Dragão");
  assert.equal(ok.config.fases.length, 3);

  const ruim = validarConfig({ vida: 0, duracaoSegundos: 5, danoPorBit: 1, chanceCritico: 2, multiplicadorCritico: 2, fases: [{ ate: 0.5, armadura: 0 }] });
  assert.ok(ruim.erros.some((e) => e.includes("vida do chefão")));
  assert.ok(ruim.erros.some((e) => e.includes("tempo limite")));
  assert.ok(ruim.erros.some((e) => e.includes("crítico")));
  assert.ok(ruim.erros.some((e) => e.includes("100%")));
});
