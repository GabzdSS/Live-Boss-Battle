import * as channels from "../repos/channels.js";
import { iniciarCanal, criarContexto } from "./canal.js";

/**
 * Supervisor: mantem ligados exatamente os canais que deveriam estar no ar.
 *
 * "Deveria estar no ar" = assinatura ativa (ou em teste/carencia) E conta da
 * Twitch conectada. A cada rodada ele compara essa lista com o que esta
 * rodando e corrige a diferenca - entao cancelamento, pagamento confirmado e
 * token revogado se resolvem sozinhos, sem ninguem reiniciar servidor.
 */

const ativos = new Map(); // channelId -> runtime
let timer = null;
let sincronizando = false;

export const getRuntime = (channelId) => ativos.get(channelId) ?? null;
export const canaisAtivos = () => [...ativos.values()];

/**
 * Contexto pra agir num canal mesmo sem runtime (canal em teste sem Twitch,
 * ou acao do painel enquanto a conexao esta caida): o golpe e gravado e
 * aparece no overlay, so nao tem anuncio no chat.
 */
export function contextoDoCanal(canal) {
  return getRuntime(canal.id)?.ctx ?? criarContexto(canal);
}

export async function sincronizar() {
  if (sincronizando) return;
  sincronizando = true;
  try {
    const deveriamRodar = await channels.listarAtivos();
    const idsDesejados = new Set(deveriamRodar.map((c) => c.id));

    for (const [channelId, runtime] of ativos) {
      if (!idsDesejados.has(channelId)) {
        console.log(`[supervisor] desligando ${runtime.canal.login}`);
        await runtime.parar();
        ativos.delete(channelId);
      }
    }

    for (const canal of deveriamRodar) {
      if (ativos.has(canal.id)) continue;
      try {
        const completo = await channels.findById(canal.id);
        const runtime = await iniciarCanal(completo);
        ativos.set(canal.id, runtime);
        console.log(`[supervisor] ${completo.login} no ar${runtime.precisaReconectar ? " (aguardando reconexao da Twitch)" : ""}`);
      } catch (err) {
        // Um canal com problema nao pode derrubar os outros.
        console.error(`[supervisor] falha ao iniciar ${canal.login}:`, err.message);
      }
    }
  } finally {
    sincronizando = false;
  }
}

export async function iniciarSupervisor({ intervaloMinutos = 5 } = {}) {
  await sincronizar();
  timer = setInterval(() => sincronizar().catch((err) => console.error("[supervisor]", err.message)), intervaloMinutos * 60 * 1000);
  console.log(`[supervisor] ${ativos.size} canal(is) no ar, reconferindo a cada ${intervaloMinutos}min`);
}

/** Usado quando algo muda agora (pagamento confirmado, conta reconectada). */
export const reconferirEmBreve = () => setTimeout(() => sincronizar().catch(() => {}), 1000);

export async function pararSupervisor() {
  clearInterval(timer);
  await Promise.all([...ativos.values()].map((r) => r.parar()));
  ativos.clear();
}
