/**
 * Motor do chefao - so conta, sem banco, sem rede, sem relogio.
 *
 * Tudo que tem sorte (critico) recebe `sortear` de fora, e tudo que tem tempo
 * fica com quem chama. E isso que deixa o jogo testavel golpe a golpe: dado o
 * mesmo estado, a mesma config e o mesmo sorteio, sai sempre o mesmo resultado.
 *
 *   dano_base    = recompensa.dano              (pontos do canal)
 *                = bits x dano_por_bit          (cheer)
 *   critico      = so cheer, com chance_critico -> dano_base x multiplicador
 *   dano_final   = dano_base x (1 - armadura da fase ATUAL), no minimo 1
 *   dano_efetivo = min(dano_final, vida restante)   <- e o que conta no ranking
 */

export const FASES_PADRAO = [
  { ate: 1, armadura: 0, imagem: null },
  { ate: 0.5, armadura: 0.2, imagem: null },
  { ate: 0.25, armadura: 0.4, imagem: null },
];

export const LIMITES = {
  vida: [1, 100_000_000],
  duracaoSegundos: [30, 6 * 60 * 60],
  danoPorBit: [0, 10_000],
  chanceCritico: [0, 1],
  multiplicadorCritico: [1, 100],
  armadura: [0, 0.95],
  danoRecompensa: [1, 10_000_000],
  custoRecompensa: [1, 10_000_000],
};

/**
 * Confere e arruma uma configuracao vinda do painel. Devolve { config } ou
 * { erros: [...] } com frases prontas pra mostrar - nada de "invalid input".
 */
export function validarConfig(entrada) {
  const erros = [];
  const num = (valor, nome, [min, max], rotulo) => {
    const n = Number(valor);
    if (!Number.isFinite(n) || n < min || n > max) {
      erros.push(`${rotulo} precisa estar entre ${min} e ${max}.`);
      return null;
    }
    return n;
  };

  const bossNome = String(entrada.bossNome ?? "").trim().slice(0, 60) || "Chefão";
  const vida = num(entrada.vida, "vida", LIMITES.vida, "A vida do chefão");
  const duracaoSegundos = num(entrada.duracaoSegundos, "duracao", LIMITES.duracaoSegundos, "O tempo limite (em segundos)");
  const danoPorBit = num(entrada.danoPorBit, "danoPorBit", LIMITES.danoPorBit, "O dano por bit");
  const chanceCritico = num(entrada.chanceCritico, "chanceCritico", LIMITES.chanceCritico, "A chance de crítico");
  const multiplicadorCritico = num(entrada.multiplicadorCritico, "multCritico", LIMITES.multiplicadorCritico, "O multiplicador de crítico");

  const fasesBrutas = Array.isArray(entrada.fases) && entrada.fases.length ? entrada.fases : FASES_PADRAO;
  const fases = fasesBrutas
    .map((f, i) => ({
      ate: Number(f.ate),
      armadura: num(f.armadura, `fase${i}`, LIMITES.armadura, `A armadura da fase ${i + 1}`),
      imagem: f.imagem ? String(f.imagem).slice(0, 500) : null,
    }))
    .sort((a, b) => b.ate - a.ate);
  if (fases[0]?.ate !== 1) erros.push("A primeira fase precisa começar com a vida cheia (100%).");
  if (fases.some((f) => !(f.ate > 0 && f.ate <= 1))) erros.push("Cada fase precisa começar entre 1% e 100% da vida.");
  if (new Set(fases.map((f) => f.ate)).size !== fases.length) erros.push("Duas fases não podem começar no mesmo ponto da vida.");
  if (fases.length > 6) erros.push("No máximo 6 fases.");

  if (erros.length) return { erros };
  return {
    config: {
      bossNome,
      vida: Math.round(vida),
      duracaoSegundos: Math.round(duracaoSegundos),
      danoPorBit,
      chanceCritico,
      multiplicadorCritico,
      fases,
    },
  };
}

/**
 * Fase em que o chefao esta com essa vida: a ultima cujo limiar ja foi
 * alcancado. Exatamente 50% ja e a fase "<= 50%".
 */
export function faseDe(vida, vidaMax, fases) {
  const fracao = vida / vidaMax;
  let fase = 0;
  for (let i = 0; i < fases.length; i++) if (fracao <= fases[i].ate) fase = i;
  return fase;
}

/**
 * Aplica um golpe.
 *
 *   estado  { vida, vidaMax, fase }
 *   config  snapshot da raid ({ danoPorBit, chanceCritico, multiplicadorCritico, fases, recompensas })
 *   golpe   { tipo: "bits", bits } | { tipo: "recompensa", chave }
 *   sortear () => numero em [0, 1)  (Math.random em producao)
 *
 * Devolve { ok, estado, resultado, eventos } ou { ok: false, motivo }.
 * `eventos` sai em ordem: golpe, fase (uma por limiar cruzado), derrotado.
 */
export function aplicarGolpe(estado, config, golpe, sortear = Math.random) {
  if (estado.vida <= 0) return { ok: false, motivo: "ja-derrotado" };

  let danoBase;
  let critico = false;
  if (golpe.tipo === "bits") {
    const bits = Math.floor(Number(golpe.bits));
    if (!(bits > 0)) return { ok: false, motivo: "bits-invalido" };
    danoBase = bits * config.danoPorBit;
    // Crítico só no cheer: é onde tem dinheiro de verdade e a surpresa paga o gesto.
    if (config.chanceCritico > 0 && sortear() < config.chanceCritico) {
      critico = true;
      danoBase *= config.multiplicadorCritico;
    }
  } else if (golpe.tipo === "recompensa") {
    const recompensa = config.recompensas?.[golpe.chave];
    if (!recompensa) return { ok: false, motivo: "recompensa-desconhecida" };
    danoBase = recompensa.dano;
  } else {
    return { ok: false, motivo: "golpe-desconhecido" };
  }

  danoBase = Math.round(danoBase);
  if (danoBase <= 0) return { ok: false, motivo: "sem-dano" }; // ex.: dano por bit configurado como 0

  const armadura = config.fases[estado.fase]?.armadura ?? 0;
  const danoFinal = Math.max(1, Math.round(danoBase * (1 - armadura)));
  const danoEfetivo = Math.min(danoFinal, estado.vida);

  const vida = estado.vida - danoEfetivo;
  const fase = faseDe(vida, estado.vidaMax, config.fases);
  const novo = { ...estado, vida, fase };

  const resultado = { danoBase, danoFinal, danoEfetivo, critico, fase: estado.fase, armadura };
  const eventos = [{ tipo: "golpe", ...resultado, vida, vidaMax: estado.vidaMax }];
  // Um golpe forte pode atravessar duas fases de uma vez: cada uma tem sua
  // animacao de "enfurecer", entao cada uma vira um evento, em ordem.
  for (let f = estado.fase + 1; f <= fase; f++) eventos.push({ tipo: "fase", fase: f, de: f - 1 });
  if (vida === 0) eventos.push({ tipo: "derrotado" });

  return { ok: true, estado: novo, resultado, eventos };
}

/** Ranking a partir de golpes { jogador, nome, danoEfetivo }. Sem jogador (anonimo) nao entra. */
export function montarRanking(golpes, limite = 10) {
  const porJogador = new Map();
  for (const g of golpes) {
    if (!g.jogador) continue;
    const atual = porJogador.get(g.jogador) ?? { jogador: g.jogador, nome: g.nome, dano: 0, golpes: 0 };
    atual.dano += g.danoEfetivo;
    atual.golpes += 1;
    atual.nome = g.nome || atual.nome;
    porJogador.set(g.jogador, atual);
  }
  return ordenarRanking([...porJogador.values()], limite);
}

/** Maior dano primeiro; empate fica com quem tem menos golpes (bateu mais forte). */
export const ordenarRanking = (linhas, limite = 10) =>
  [...linhas].sort((a, b) => b.dano - a.dano || a.golpes - b.golpes || a.nome.localeCompare(b.nome)).slice(0, limite);
