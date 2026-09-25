import crypto from "crypto";
import { config } from "../../config/env.js";
import { one, query } from "../../db/index.js";
import * as subscriptions from "../../repos/subscriptions.js";
import { safeEqual } from "../../lib/secretBox.js";

const API = "https://api.mercadopago.com";
const MS_DIA = 24 * 60 * 60 * 1000;

/**
 * Mercado Pago.
 *
 * Dois caminhos, porque no Brasil um so nao atende:
 *
 *   cartao recorrente (preapproval) - o MP cobra sozinho todo mes e avisa por
 *     webhook. E a unica recorrencia automatica disponivel pela API: o Pix
 *     Automatico existe, mas exige contratar o produto a parte com eles.
 *
 *   pagamento avulso (preference)  - Pix, saldo ou cartao numa cobranca so.
 *     Cada pagamento aprovado estende o acesso em 30 dias. Nao renova sozinho,
 *     entao o painel avisa antes de vencer.
 *
 * Em nenhum dos dois o cartao passa por aqui: quem coleta e o checkout do MP.
 * Menos risco, menos obrigacao de PCI, menos coisa nossa pra vazar.
 */

const precoMensal = () => Number(process.env.PRECO_MENSAL || 19.9);
const tokenAcesso = () => process.env.MP_ACCESS_TOKEN || "";

async function chamarMP(caminho, opcoes = {}) {
  const res = await fetch(`${API}${caminho}`, {
    ...opcoes,
    headers: {
      Authorization: `Bearer ${tokenAcesso()}`,
      "Content-Type": "application/json",
      ...opcoes.headers,
    },
  });
  const corpo = await res.json().catch(() => ({}));
  if (!res.ok) {
    const erro = new Error(`Mercado Pago ${res.status}: ${corpo.message || JSON.stringify(corpo).slice(0, 300)}`);
    erro.status = res.status;
    erro.corpo = corpo;
    throw erro;
  }
  return corpo;
}

/**
 * Assinatura no cartao. Devolve a URL do checkout do MP pra streamer autorizar.
 *
 * `external_reference` carrega o id do canal - e por ele que o webhook sabe
 * quem pagou, sem depender de e-mail (que a pessoa pode ter trocado na Twitch).
 */
async function assinarCartao(canal, { email }) {
  const assinatura = await chamarMP("/preapproval", {
    method: "POST",
    body: JSON.stringify({
      reason: `Boss Raid — canal ${canal.login}`,
      external_reference: canal.id,
      payer_email: email,
      back_url: `${config.baseUrl}/painel/assinatura?retorno=cartao`,
      // "pending" faz o MP hospedar a captura do cartao e devolver init_point.
      status: "pending",
      auto_recurring: {
        frequency: 1,
        frequency_type: "months",
        transaction_amount: precoMensal(),
        currency_id: "BRL",
      },
    }),
  });

  await subscriptions.upsert(canal.id, {
    provider: "mercadopago",
    externalId: assinatura.id,
    status: "trialing",
    raw: { tipo: "preapproval", criadoEm: new Date().toISOString() },
  });
  await query("update subscriptions set checkout_url = $2 where channel_id = $1", [canal.id, assinatura.init_point]);

  return { url: assinatura.init_point, id: assinatura.id };
}

/** Cobranca avulsa de 1 mes (Pix na frente, mas aceita os outros meios do MP). */
async function pagarUmMes(canal) {
  const preferencia = await chamarMP("/checkout/preferences", {
    method: "POST",
    body: JSON.stringify({
      items: [
        {
          title: `Boss Raid — 1 mês (canal ${canal.login})`,
          quantity: 1,
          unit_price: precoMensal(),
          currency_id: "BRL",
        },
      ],
      external_reference: canal.id,
      notification_url: `${config.baseUrl}/webhooks/mercadopago`,
      back_urls: {
        success: `${config.baseUrl}/painel/assinatura?retorno=pix`,
        pending: `${config.baseUrl}/painel/assinatura?retorno=pix`,
        failure: `${config.baseUrl}/painel/assinatura?retorno=falhou`,
      },
      auto_return: "approved",
      // Pix cai como bank_transfer: tirando cartao parcelado e boleto, ele
      // fica em primeiro na tela em vez de escondido atras de tudo.
      payment_methods: { excluded_payment_types: [{ id: "ticket" }], installments: 1 },
    }),
  });

  return { url: preferencia.init_point, id: preferencia.id };
}

/**
 * Valida a assinatura do webhook.
 *
 * Sem isso, a rota de webhook e um jeito publico de ativar assinatura: basta
 * alguem descobrir a URL e mandar um POST dizendo "pago". O MP assina cada
 * notificacao com um segredo que so o painel dele e a gente conhece.
 */
export function assinaturaValida({ xSignature, xRequestId, dataId, segredo = process.env.MP_WEBHOOK_SECRET }) {
  if (!segredo) return { ok: false, motivo: "MP_WEBHOOK_SECRET nao configurado" };
  if (!xSignature || !dataId) return { ok: false, motivo: "cabecalhos ausentes" };

  const partes = Object.fromEntries(
    String(xSignature)
      .split(",")
      .map((p) => p.split("=").map((x) => x.trim()))
      .filter((p) => p.length === 2)
  );
  const { ts, v1 } = partes;
  if (!ts || !v1) return { ok: false, motivo: "x-signature malformado" };

  // Notificacao muito velha = replay. 10 minutos cobre atraso de rede e
  // reentrega do MP sem abrir janela pra alguem reaproveitar uma captura.
  const idadeMs = Math.abs(Date.now() - Number(ts));
  if (!Number.isFinite(idadeMs) || idadeMs > 10 * 60 * 1000) return { ok: false, motivo: "timestamp fora da janela" };

  const manifesto = `id:${dataId};request-id:${xRequestId ?? ""};ts:${ts};`;
  const esperado = crypto.createHmac("sha256", segredo).update(manifesto).digest("hex");
  return safeEqual(esperado, v1) ? { ok: true } : { ok: false, motivo: "assinatura nao confere" };
}

/** Já processamos essa notificação? (o MP reenvia até receber 200) */
async function jaProcessado(chave) {
  return Boolean(await one("select id from billing_events where id = $1", [chave]));
}

async function registrarEvento(chave, { channelId, kind, status, raw }) {
  await query(
    `insert into billing_events (id, channel_id, provider, kind, status, raw)
     values ($1, $2, 'mercadopago', $3, $4, $5) on conflict (id) do nothing`,
    [chave, channelId ?? null, kind, status ?? null, JSON.stringify(raw ?? {})]
  );
}

const canalDoExternalReference = (ref) =>
  ref && /^[0-9a-f-]{36}$/i.test(String(ref)) ? one("select id, login from channels where id = $1", [ref]) : null;

/**
 * Traduz o estado do MP pro nosso.
 *
 * `authorized` = cartao autorizado e cobranca em dia. `paused` acontece quando
 * o MP suspende por falha de pagamento: viramos past_due com uma semana de
 * carencia em vez de cortar na hora - cartao vencido e o motivo mais comum, e
 * cortar o canal no meio de uma live por isso seria cruel.
 */
function traduzirPreapproval(mp) {
  const proximo = mp.next_payment_date ? new Date(mp.next_payment_date) : null;
  switch (mp.status) {
    case "authorized":
      return { status: "active", currentPeriodEnd: proximo, graceUntil: null };
    case "paused":
      return { status: "past_due", currentPeriodEnd: proximo, graceUntil: new Date(Date.now() + 7 * MS_DIA) };
    case "cancelled":
      return { status: "canceled", currentPeriodEnd: null, graceUntil: null };
    default:
      return null; // "pending": ainda nao autorizou, o trial continua valendo
  }
}

/**
 * Processa uma notificacao ja validada. Recebe o tipo e o id do recurso, e
 * BUSCA o estado na API do MP - nunca confia no corpo do POST, que e so um
 * aviso de "algo mudou, vai conferir".
 */
export async function processarNotificacao({ tipo, id, chaveIdempotencia }) {
  const chave = chaveIdempotencia ?? `${tipo}:${id}`;
  if (await jaProcessado(chave)) return { ignorado: true, motivo: "ja processado" };

  if (tipo === "subscription_preapproval" || tipo === "preapproval") {
    const mp = await chamarMP(`/preapproval/${id}`);
    const canal = await canalDoExternalReference(mp.external_reference);
    const traduzido = traduzirPreapproval(mp);
    if (canal && traduzido) {
      await subscriptions.upsert(canal.id, {
        provider: "mercadopago",
        externalId: mp.id,
        status: traduzido.status,
        currentPeriodEnd: traduzido.currentPeriodEnd,
        graceUntil: traduzido.graceUntil,
        raw: { mpStatus: mp.status, atualizadoEm: new Date().toISOString() },
      });
    }
    await registrarEvento(chave, { channelId: canal?.id, kind: "preapproval", status: mp.status, raw: mp });
    return { canal: canal?.login, status: traduzido?.status ?? mp.status };
  }

  // Cobranca mensal do cartao: o MP avisa a cada ciclo, aprovado ou nao.
  if (tipo === "subscription_authorized_payment") {
    const cobranca = await chamarMP(`/authorized_payments/${id}`);
    const mp = await chamarMP(`/preapproval/${cobranca.preapproval_id}`);
    const canal = await canalDoExternalReference(mp.external_reference);
    const aprovado = cobranca.status === "processed" || cobranca.payment?.status === "approved";

    if (canal) {
      await subscriptions.upsert(canal.id, {
        provider: "mercadopago",
        externalId: mp.id,
        status: aprovado ? "active" : "past_due",
        currentPeriodEnd: mp.next_payment_date ? new Date(mp.next_payment_date) : null,
        graceUntil: aprovado ? null : new Date(Date.now() + 7 * MS_DIA),
        raw: { cobranca: cobranca.status, pagamento: cobranca.payment?.status ?? null },
      });
      if (aprovado) {
        await query("update subscriptions set ultimo_pagamento_em = now() where channel_id = $1", [canal.id]);
      }
    }
    await registrarEvento(chave, { channelId: canal?.id, kind: "cobranca-mensal", status: cobranca.status, raw: cobranca });
    return { canal: canal?.login, status: aprovado ? "active" : "past_due" };
  }

  // Pagamento avulso (Pix e afins): cada aprovacao estende 30 dias.
  if (tipo === "payment") {
    const pagamento = await chamarMP(`/v1/payments/${id}`);
    const canal = await canalDoExternalReference(pagamento.external_reference);

    if (canal && pagamento.status === "approved") {
      const atual = await subscriptions.get(canal.id);
      // Quem paga adiantado nao perde o que ja tinha: soma a partir do fim do
      // periodo atual, nao de hoje.
      const base = atual?.current_period_end && new Date(atual.current_period_end) > new Date()
        ? new Date(atual.current_period_end)
        : new Date();
      await subscriptions.upsert(canal.id, {
        provider: "mercadopago",
        externalId: atual?.external_id ?? String(pagamento.id),
        status: "active",
        currentPeriodEnd: new Date(base.getTime() + 30 * MS_DIA),
        graceUntil: null,
        raw: { avulso: pagamento.id, meio: pagamento.payment_method_id, valor: pagamento.transaction_amount },
      });
      await query("update subscriptions set ultimo_pagamento_em = now() where channel_id = $1", [canal.id]);
    }
    await registrarEvento(chave, { channelId: canal?.id, kind: "pagamento-avulso", status: pagamento.status, raw: pagamento });
    return { canal: canal?.login, status: pagamento.status };
  }

  await registrarEvento(chave, { kind: `ignorado:${tipo}`, raw: { tipo, id } });
  return { ignorado: true, motivo: `tipo nao tratado: ${tipo}` };
}

export const mercadopago = {
  nome: "mercadopago",
  exibicao: "Mercado Pago",
  suportaCheckout: true,
  configurado: () => Boolean(tokenAcesso()),
  precoMensal,

  async iniciarCheckout(canal, { email, forma = "cartao" } = {}) {
    if (!tokenAcesso()) throw Object.assign(new Error("Mercado Pago não configurado (falta MP_ACCESS_TOKEN)."), { status: 503, expose: true });
    if (forma === "pix") return pagarUmMes(canal);
    if (!email) throw Object.assign(new Error("Precisamos de um e-mail para a assinatura no cartão."), { status: 400, expose: true });
    return assinarCartao(canal, { email });
  },

  /** Cancela no MP e no nosso banco. O acesso continua ate o fim do periodo pago. */
  async cancelar(channelId) {
    const atual = await subscriptions.get(channelId);
    if (atual?.external_id && atual.provider === "mercadopago") {
      await chamarMP(`/preapproval/${atual.external_id}`, {
        method: "PUT",
        body: JSON.stringify({ status: "cancelled" }),
      }).catch((err) => console.error("[mp] falha ao cancelar no provedor:", err.message));
    }
    return subscriptions.upsert(channelId, {
      provider: "mercadopago",
      externalId: atual?.external_id ?? null,
      status: "canceled",
      // Ja pagou o mes: usa ate o fim. Cortar na hora do cancelamento seria
      // cobrar por um servico que nao entregou.
      currentPeriodEnd: atual?.current_period_end ?? null,
      graceUntil: atual?.current_period_end ?? null,
      raw: { canceladoEm: new Date().toISOString() },
    });
  },

  processarNotificacao,
  assinaturaValida,
};
