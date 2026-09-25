/**
 * Planos e limites.
 *
 * Os limites existem por dois motivos: storage e banda custam dinheiro por
 * cliente, e limite claro e o que faz a pessoa subir de plano sem se sentir
 * enganada. Os numeros sao um ponto de partida - mexer aqui muda o produto
 * inteiro, nao precisa tocar em codigo nenhum.
 *
 * Preco fica de fora de proposito: quem cobra e o provedor de pagamento.
 */
export const PLANOS = {
  basico: {
    id: "basico",
    nome: "Básico",
    // imagens do chefao (uma por fase) e da tela de vitoria
    storageMb: 50,
  },
  pro: {
    id: "pro",
    nome: "Pro",
    storageMb: 200,
  },
};

export const planoDe = (assinatura) => PLANOS[assinatura?.plan] ?? PLANOS.basico;

export const formatarMb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
