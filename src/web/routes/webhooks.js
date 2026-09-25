import express from "express";
import { mercadopago } from "../../billing/providers/mercadopago.js";
import { reconferirEmBreve } from "../../runtime/supervisor.js";

export const router = express.Router();

/**
 * Webhook do Mercado Pago.
 *
 * Tres cuidados que definem se isso e seguro ou e um botao publico de liberar
 * assinatura:
 *
 *   1. assinatura HMAC conferida antes de qualquer coisa
 *   2. o corpo do POST e so um aviso: o estado real vem da API do MP
 *   3. notificacao repetida nao reprocessa (o MP reenvia ate receber 200)
 *
 * E um cuidado operacional: responder rapido. Se demorarmos, o MP considera
 * falha e reenvia - por isso a resposta sai antes do processamento pesado.
 */
router.post("/webhooks/mercadopago", express.json({ limit: "200kb" }), async (req, res) => {
  const dataId = String(req.query["data.id"] ?? req.body?.data?.id ?? "");
  const tipo = String(req.query.type ?? req.body?.type ?? req.body?.topic ?? "");

  const conferencia = mercadopago.assinaturaValida({
    xSignature: req.headers["x-signature"],
    xRequestId: req.headers["x-request-id"],
    dataId,
  });

  if (!conferencia.ok) {
    console.warn(`[webhook mp] recusado (${conferencia.motivo}) tipo=${tipo} id=${dataId}`);
    // 401 e proposital: o MP para de reenviar o que nunca vai ser aceito, e
    // fica registrado no painel deles que a assinatura esta errada.
    return res.status(401).json({ ok: false, error: "assinatura inválida" });
  }

  // Confirma o recebimento antes de processar: o resto pode levar segundos
  // (duas chamadas na API do MP) e nao vale arriscar reenvio por timeout.
  res.status(200).json({ ok: true });

  try {
    const resultado = await mercadopago.processarNotificacao({
      tipo,
      id: dataId,
      chaveIdempotencia: `${tipo}:${dataId}:${req.body?.action ?? ""}`,
    });
    if (resultado.ignorado) {
      console.log(`[webhook mp] ${tipo} ${dataId}: ${resultado.motivo}`);
    } else {
      console.log(`[webhook mp] ${tipo} -> canal ${resultado.canal ?? "?"} status ${resultado.status}`);
      // Pagou: o canal precisa voltar ao ar agora, nao na proxima rodada.
      reconferirEmBreve();
    }
  } catch (err) {
    console.error(`[webhook mp] falha ao processar ${tipo} ${dataId}:`, err.message);
  }
});
