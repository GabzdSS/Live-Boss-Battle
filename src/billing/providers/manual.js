import * as subscriptions from "../../repos/subscriptions.js";

/**
 * Provedor "manual": voce ativa e desativa canal na mao (ou por script).
 *
 * Serve pros primeiros clientes - inclusive pra quem paga por Pix direto pra
 * voce - e serve de espelho pros provedores de verdade: se o produto funciona
 * inteiro em cima desta interface, plugar Mercado Pago/Stripe/Kiwify depois
 * nao encosta em nenhuma regra de acesso.
 */
export const manual = {
  nome: "manual",
  exibicao: "Ativação manual",
  suportaCheckout: false,

  async iniciarCheckout() {
    return { url: null, mensagem: "Cobrança manual: combine o pagamento e ative o canal pelo painel de dono." };
  },

  async ativar(channelId, { dias = 30, plan = "basico" } = {}) {
    return subscriptions.upsert(channelId, {
      provider: "manual",
      plan,
      status: "active",
      currentPeriodEnd: new Date(Date.now() + dias * 24 * 60 * 60 * 1000),
      raw: { ativadoEm: new Date().toISOString(), dias },
    });
  },

  async cancelar(channelId, { motivo = "cancelado manualmente" } = {}) {
    return subscriptions.upsert(channelId, { provider: "manual", status: "canceled", raw: { motivo } });
  },

  // Sem provedor externo nao ha webhook: existe so pra interface fechar.
  async tratarWebhook() {
    return { ignorado: true };
  },
};
