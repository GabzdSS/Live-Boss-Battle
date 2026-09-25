import { createServer } from "http";
import { config, assertConfig, isProduction } from "./config/env.js";
import { migrate } from "./db/migrate.js";
import { close as fecharBanco } from "./db/index.js";
import { pruneExpired } from "./lib/session.js";
import { criarApp } from "./web/app.js";
import { iniciarSockets, definirAoConectar } from "./web/sockets.js";
import { restaurarRaidsAtivas, snapshotDoCanal } from "./domain/raid.js";
import { iniciarSupervisor, pararSupervisor } from "./runtime/supervisor.js";

const faltando = assertConfig();
if (faltando.length) {
  console.error(`[config] faltam variaveis: ${faltando.join(", ")}`);
  if (isProduction) process.exit(1);
  console.warn("[config] seguindo mesmo assim (dev) - login com a Twitch nao vai funcionar sem elas");
}

// Toca nas chaves logo no arranque: em dev elas se geram sozinhas, e se isso
// acontecesse tarde (num pedido) dois processos poderiam gerar chaves
// diferentes e invalidar a sessao de quem ja estava logado.
void config.secretKey;
void config.tokenKey;

await migrate();

const app = await criarApp();
const httpServer = createServer(app);
iniciarSockets(httpServer);
definirAoConectar(async (socket) => socket.emit("raid:estado", await snapshotDoCanal(socket.data.channelId)));

// Raid que estava rodando quando o servidor caiu volta a contar (ou foge, se o prazo venceu).
await restaurarRaidsAtivas();

// Liga os canais que devem estar no ar (assinatura valida + Twitch conectada).
await iniciarSupervisor();

// Faxina de sessao vencida e state de OAuth abandonado.
setInterval(() => pruneExpired().catch((e) => console.error("[faxina]", e.message)), 60 * 60 * 1000);

httpServer.listen(config.port, () => {
  console.log(`\n  Boss Raid no ar em ${config.baseUrl}`);
  console.log(`  Entrar:  ${config.baseUrl}/entrar`);
  console.log(`  Painel:  ${config.baseUrl}/painel\n`);
});

const desligar = async (sinal) => {
  console.log(`\n[${sinal}] desligando...`);
  await pararSupervisor();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on("SIGINT", () => desligar("SIGINT"));
process.on("SIGTERM", () => desligar("SIGTERM"));
