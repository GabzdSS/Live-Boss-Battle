import { manual } from "./providers/manual.js";
import { mercadopago } from "./providers/mercadopago.js";

/**
 * Registro de provedores de cobranca. Trocar de provedor (ou rodar dois ao
 * mesmo tempo, tipo Pix manual + cartao recorrente) e mexer so aqui.
 *
 * Contrato que um provedor novo precisa cumprir:
 *   nome, exibicao, suportaCheckout
 *   iniciarCheckout(canal, plano) -> { url }
 *   cancelar(channelId, opcoes)
 *   tratarWebhook(req) -> { channelId, status, currentPeriodEnd, externalId, raw }
 */
const REGISTRO = { manual, mercadopago };

export const provedorAtual = () => REGISTRO[process.env.BILLING_PROVIDER || "manual"] ?? manual;
export const registrar = (provedor) => (REGISTRO[provedor.nome] = provedor);
export const porNome = (nome) => REGISTRO[nome] ?? null;
export { manual, mercadopago };
