import * as subscriptions from "../repos/subscriptions.js";

/**
 * Regra de acesso do produto - um lugar so, porque essa decisao aparece em
 * muitos lugares (ligar o EventSub, entrar no chat, iniciar raid pelo painel)
 * e divergencia entre eles vira cliente pagando sem usar, ou usando sem pagar.
 *
 * Decisao de produto (a mesma do SubPack): quando a assinatura acaba, o canal
 * para de FUNCIONAR (sem raid, sem bot), mas o que e dos viewers - ranking e
 * hall da fama - continua visivel. Sumir com isso porque a streamer atrasou o
 * cartao seria punir quem nao tem nada a ver com isso.
 */

const MS_DIA = 24 * 60 * 60 * 1000;
const diasAte = (data) => (data ? Math.ceil((new Date(data).getTime() - Date.now()) / MS_DIA) : null);

export function avaliar(assinatura) {
  if (!assinatura) return { ativo: false, estado: "sem-assinatura", rotulo: "Sem assinatura", podeEditar: false };

  const agora = Date.now();
  const emCarencia = assinatura.grace_until && new Date(assinatura.grace_until).getTime() > agora;

  if (assinatura.status === "active") {
    return {
      ativo: true,
      estado: "ativa",
      rotulo: "Assinatura ativa",
      podeEditar: true,
      renovaEm: assinatura.current_period_end,
    };
  }

  if (assinatura.status === "trialing" && new Date(assinatura.trial_ends_at ?? 0).getTime() > agora) {
    const dias = diasAte(assinatura.trial_ends_at);
    return {
      ativo: true,
      estado: "teste",
      rotulo: dias === 1 ? "Último dia de teste" : `Teste grátis — ${dias} dias restantes`,
      podeEditar: true,
      terminaEm: assinatura.trial_ends_at,
      avisar: dias <= 3,
    };
  }

  // Cancelou mas o mes ja estava pago: continua funcionando ate o fim, e o
  // aviso precisa dizer isso - "pagamento pendente" aqui seria mentira e
  // faria a pessoa achar que foi cobrada de novo.
  if (assinatura.status === "canceled" && assinatura.current_period_end && new Date(assinatura.current_period_end).getTime() > agora) {
    return {
      ativo: true,
      estado: "cancelada-com-prazo",
      rotulo: `Assinatura cancelada — seu canal funciona até ${new Date(assinatura.current_period_end).toLocaleDateString("pt-BR")}`,
      podeEditar: true,
      terminaEm: assinatura.current_period_end,
      avisar: true,
    };
  }

  if (emCarencia) {
    return {
      ativo: true,
      estado: "carencia",
      rotulo: "Pagamento pendente — seu canal continua no ar por poucos dias",
      podeEditar: true,
      terminaEm: assinatura.grace_until,
      avisar: true,
    };
  }

  const rotulos = {
    trialing: "Seu teste grátis terminou",
    past_due: "Pagamento não confirmado",
    canceled: "Assinatura cancelada",
  };
  return {
    ativo: false,
    estado: assinatura.status === "canceled" ? "cancelada" : "expirada",
    rotulo: rotulos[assinatura.status] ?? "Assinatura inativa",
    // Sem assinatura ela ainda entra no painel e ve tudo - so nao muda nada
    // nem inicia raid. Assim o caminho de voltar a pagar fica curto.
    podeEditar: false,
    avisar: true,
  };
}

export async function doCanal(channelId) {
  return avaliar(await subscriptions.get(channelId));
}
