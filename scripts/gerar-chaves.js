/** Imprime chaves novas pra colar no ambiente de producao. */
import crypto from "crypto";
const chave = () => crypto.randomBytes(32).toString("base64");
console.log(`
Cole no ambiente do servidor (Railway/Render/VPS). Guarde em lugar seguro:

APP_SECRET_KEY=${chave()}
TOKEN_ENCRYPTION_KEY=${chave()}

Atencao: trocar TOKEN_ENCRYPTION_KEY depois torna ilegiveis os tokens ja
salvos - todos os canais teriam que reconectar a conta da Twitch.
`);
