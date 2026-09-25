import express from "express";
import { requireSession } from "../middleware.js";
import { contextoDoCanal } from "../../runtime/supervisor.js";
import { raidDoCanal, gatilhoDeTeste } from "../../domain/raid.js";
import { validarConfig } from "../../domain/boss.js";
import * as raidConfig from "../../repos/raidConfig.js";
import * as channels from "../../repos/channels.js";
import * as acessoBilling from "../../billing/access.js";

export const router = express.Router();

router.use("/api/painel/raid", requireSession);

/**
 * Controle da raid e modo de teste. O canal vem SEMPRE da sessao, nunca do
 * corpo do pedido - ninguem inicia raid no canal alheio.
 */

async function exigirAcesso(req, res) {
  const acesso = await acessoBilling.doCanal(req.channelId);
  if (!acesso.podeEditar) {
    res.status(402).json({ ok: false, error: acesso.rotulo, acesso });
    return false;
  }
  return true;
}

const MOTIVOS = {
  "sem-raid": "Não tem raid em andamento.",
  "ja-pausada": "A raid já está pausada.",
  "nao-pausada": "A raid não está pausada.",
  pausada: "A raid está pausada: só cheers contam agora.",
  "recompensa-desconhecida": "Essa recompensa não existe.",
  "bits-invalido": "Quantidade de bits inválida.",
  "sem-dano": "Esse golpe não causa dano com a configuração atual (dano por bit = 0?).",
};
const erro = (res, status, motivo) => res.status(status).json({ ok: false, motivo, error: MOTIVOS[motivo] ?? motivo });

/** Estado da raid + configuracao atual (o que a tela do painel precisa). */
router.get("/api/painel/raid", async (req, res, next) => {
  try {
    const gerente = raidDoCanal(req.channelId);
    await gerente.pronto();
    const [config, recompensas] = await Promise.all([raidConfig.obter(req.channelId), raidConfig.listarRecompensas(req.channelId)]);
    res.json({ ok: true, raid: gerente.snapshot(), config, recompensas });
  } catch (err) {
    next(err);
  }
});

router.put("/api/painel/raid/config", async (req, res, next) => {
  try {
    if (!(await exigirAcesso(req, res))) return;
    const { config, erros } = validarConfig(req.body ?? {});
    if (erros) return res.status(400).json({ ok: false, error: erros.join(" "), erros });
    res.json({ ok: true, config: await raidConfig.salvar(req.channelId, config) });
  } catch (err) {
    next(err);
  }
});

router.post("/api/painel/raid/iniciar", async (req, res, next) => {
  try {
    if (!(await exigirAcesso(req, res))) return;
    const estado = await raidDoCanal(req.channelId).iniciar({ teste: Boolean(req.body?.teste) });
    res.json({ ok: true, raid: estado });
  } catch (err) {
    if (err.codigo === "ja-tem-raid") return res.status(409).json({ ok: false, motivo: err.codigo, error: err.message });
    next(err);
  }
});

for (const acao of ["pausar", "retomar", "encerrar"]) {
  router.post(`/api/painel/raid/${acao}`, async (req, res, next) => {
    try {
      const r = await raidDoCanal(req.channelId)[acao]();
      if (!r.ok) return erro(res, 409, r.motivo);
      res.json({ ok: true, raid: raidDoCanal(req.channelId).snapshot(), final: r.final ?? null });
    } catch (err) {
      next(err);
    }
  });
}

/**
 * Modo de teste: um golpe simulado entra pelo MESMO caminho do EventSub
 * (ctx.receberGatilho), entao o que funciona aqui funciona ao vivo.
 * Corpo: { nome, recompensa: "ataque" | "ataque-forte" } ou { nome, bits }.
 */
router.post("/api/painel/raid/teste/golpe", async (req, res, next) => {
  try {
    const { nome, recompensa, bits } = req.body ?? {};
    if (!bits && !recompensa) return res.status(400).json({ ok: false, error: "Informe a recompensa ou a quantidade de bits." });
    if (bits && !(Number(bits) >= 1 && Number(bits) <= 1_000_000)) return erro(res, 400, "bits-invalido");

    const canal = await channels.findById(req.channelId);
    const r = await contextoDoCanal(canal).receberGatilho(gatilhoDeTeste({ nome, recompensa, bits }));
    if (!r.ok) return erro(res, 409, r.motivo);
    res.json({ ok: true, golpe: r, raid: raidDoCanal(req.channelId).snapshot() });
  } catch (err) {
    next(err);
  }
});
