import express from "express";
import { requireSession } from "../middleware.js";
import { provedorAtual } from "../../billing/index.js";
import * as acessoBilling from "../../billing/access.js";
import * as subscriptions from "../../repos/subscriptions.js";
import * as channels from "../../repos/channels.js";
import { PLANOS } from "../../billing/planos.js";
import { reconferirEmBreve } from "../../runtime/supervisor.js";

export const router = express.Router();

router.use("/api/painel", requireSession);

router.get("/api/painel/assinatura", async (req, res, next) => {
  try {
    const [acesso, assinatura, canal] = await Promise.all([
      acessoBilling.doCanal(req.channelId),
      subscriptions.get(req.channelId),
      channels.findById(req.channelId),
    ]);
    const provedor = provedorAtual();

    res.json({
      ok: true,
      acesso,
      email: canal.email,
      login: canal.login,
      preco: provedor.precoMensal?.() ?? Number(process.env.PRECO_MENSAL || 19.9),
      provedor: { nome: provedor.nome, exibicao: provedor.exibicao, configurado: provedor.configurado?.() ?? true },
      assinatura: assinatura
        ? {
            status: assinatura.status,
            plano: PLANOS[assinatura.plan]?.nome ?? assinatura.plan,
            renovaEm: assinatura.current_period_end,
            trialAte: assinatura.trial_ends_at,
            ultimoPagamentoEm: assinatura.ultimo_pagamento_em,
            temAssinaturaNoProvedor: Boolean(assinatura.external_id),
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Começa o pagamento. Devolve a URL do checkout do provedor - o cartão e o
 * Pix são digitados lá, nunca aqui: dado de pagamento que não passa pelo nosso
 * servidor é dado que não temos como vazar.
 */
router.post("/api/painel/assinatura/checkout", async (req, res, next) => {
  try {
    const provedor = provedorAtual();
    if (!provedor.suportaCheckout) {
      return res.status(503).json({ ok: false, error: "A cobrança ainda está em modo manual. Fale com o suporte." });
    }

    const canal = await channels.findById(req.channelId);
    const forma = req.body.forma === "pix" ? "pix" : "cartao";
    const email = String(req.body.email || canal.email || "").trim();

    if (forma === "cartao" && !email) {
      return res.status(400).json({ ok: false, error: "Informe um e-mail para a assinatura no cartão." });
    }

    const checkout = await provedor.iniciarCheckout(canal, { email, forma });
    res.json({ ok: true, url: checkout.url, forma });
  } catch (err) {
    // O Mercado Pago recusa quando quem paga é a mesma conta que recebe -
    // acontece sempre no primeiro teste do dono. A mensagem crua ("invalid
    // payer") não ajuda ninguém.
    const texto = String(err.corpo?.message ?? err.message ?? "");
    if (/payer|collector|same account/i.test(texto)) {
      return res.status(400).json({
        ok: false,
        error: "O Mercado Pago não deixa pagar para a própria conta que recebe. Use um e-mail diferente do da sua conta de vendedor (em teste, uma conta de teste do MP).",
      });
    }
    next(err);
  }
});

router.post("/api/painel/assinatura/cancelar", async (req, res, next) => {
  try {
    const provedor = provedorAtual();
    const assinatura = await provedor.cancelar(req.channelId, { motivo: "cancelado pelo painel" });
    reconferirEmBreve();
    res.json({ ok: true, acesso: acessoBilling.avaliar(assinatura) });
  } catch (err) {
    next(err);
  }
});
