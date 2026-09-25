import tmi from "tmi.js";

/**
 * Bot de chat de UM canal, falando com a conta da propria streamer.
 *
 * Mesma conexao do SubPack. Os comandos da raid (!raid, !dano) e os anuncios
 * entram na etapa 3; por enquanto o bot conecta, fala e repassa comandos pra
 * quem quiser tratar (`aoComando`).
 */
export function criarChat(ctx, { aoComando } = {}) {
  const { canal } = ctx;
  let cliente = null;
  let ultimoErro = null;

  const dizer = (mensagem) =>
    cliente?.say(canal.login, mensagem).catch((err) => {
      ultimoErro = err.message;
      console.error(`[chat ${canal.login}] erro ao enviar:`, err.message);
    });

  async function tratarMensagem(_canalIrc, tags, mensagem, ehMeuEco) {
    if (ehMeuEco || !aoComando) return;
    const texto = mensagem.trim();
    if (!texto.startsWith("!")) return;
    const partes = texto.split(/\s+/);
    await aoComando({
      comando: partes[0].toLowerCase(),
      args: partes.slice(1),
      login: tags.username,
      nome: tags["display-name"] || tags.username,
      userId: tags["user-id"] ?? null,
      ehModOuDono: Boolean(tags.mod) || tags.badges?.broadcaster === "1",
      dizer,
    });
  }

  return {
    async conectar(oauthToken) {
      cliente = new tmi.Client({
        options: { skipUpdatingEmotesets: true },
        connection: { reconnect: true, secure: true },
        identity: { username: canal.login, password: `oauth:${oauthToken}` },
        channels: [canal.login],
      });

      cliente.on("message", (...args) => {
        tratarMensagem(...args).catch((err) => console.error(`[chat ${canal.login}]`, err.message));
      });

      try {
        await cliente.connect();
        ultimoErro = null;
        console.log(`[chat] conectado ao canal ${canal.login}`);
      } catch (err) {
        ultimoErro = err.message ?? String(err);
        console.error(`[chat ${canal.login}] falha ao conectar:`, ultimoErro);
      }
    },

    /**
     * Token novo depois da renovacao. O tmi.js so usa a senha ao (re)conectar,
     * entao trocar o valor sem reconectar deixaria a conexao atual com o token
     * velho - que vence no meio da live. Por isso reconecta de fato.
     */
    async atualizarToken(oauthToken) {
      if (!cliente) return;
      cliente.opts.identity.password = `oauth:${oauthToken}`;
      try {
        await cliente.disconnect();
        await cliente.connect();
      } catch (err) {
        console.error(`[chat ${canal.login}] falha ao reconectar com token novo:`, err.message ?? err);
      }
    },

    dizer,

    getStatus: () => ({
      conectado: cliente?.readyState() === "OPEN",
      canal: canal.login,
      ultimoErro,
    }),

    async desconectar() {
      try {
        await cliente?.disconnect();
      } catch {
        // ja estava desconectado
      }
      cliente = null;
    },
  };
}
