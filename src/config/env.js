import "dotenv/config";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const isProduction = process.env.NODE_ENV === "production";

/**
 * Em producao toda chave tem que vir do ambiente. Em dev, gerar e salvar no
 * .env sozinho evita que qualquer um que clone o projeto fique travado antes
 * de conseguir rodar - e mantem a chave estavel entre restarts (se mudasse,
 * os tokens ja salvos viravam lixo indecifravel).
 */
function requireSecret(name, { generate } = {}) {
  const current = process.env[name];
  if (current) return current;
  if (isProduction || !generate) {
    throw new Error(`Variavel ${name} ausente. Gere uma com: npm run gerar-chaves`);
  }
  const value = generate();
  const envPath = path.join(ROOT, ".env");
  const line = `${name}=${value}`;
  const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
  fs.writeFileSync(envPath, content.trimEnd() + `\n\n# gerada automaticamente em dev (${new Date().toISOString()})\n${line}\n`);
  process.env[name] = value;
  console.warn(`[config] ${name} nao existia - gerei uma e salvei no .env (so acontece em dev)`);
  return value;
}

const randomKey = () => crypto.randomBytes(32).toString("base64");

export const config = {
  root: ROOT,
  port: Number(process.env.PORT) || 3000,
  // URL publica do servico inteiro (album, overlay, callback do OAuth).
  // Em dev pode ser a URL do tunel; em producao, o dominio de verdade.
  baseUrl: (process.env.BASE_URL || `http://localhost:${Number(process.env.PORT) || 3000}`).replace(/\/+$/, ""),

  db: {
    // Com DATABASE_URL usa Postgres de verdade (Neon/Railway/VPS).
    // Sem ela, cai no PGlite local - mesmo dialeto, zero instalacao.
    url: process.env.DATABASE_URL || null,
    // PGLITE_DIR=memory:// deixa o banco so na memoria (os testes usam isso).
    localDir: process.env.PGLITE_DIR || path.join(ROOT, "data", "pg"),
  },

  twitch: {
    clientId: process.env.TWITCH_CLIENT_ID || "",
    clientSecret: process.env.TWITCH_CLIENT_SECRET || "",
    get redirectUri() {
      return `${config.baseUrl}/auth/twitch/callback`;
    },
  },

  get secretKey() {
    return requireSecret("APP_SECRET_KEY", { generate: randomKey });
  },
  get tokenKey() {
    return requireSecret("TOKEN_ENCRYPTION_KEY", { generate: randomKey });
  },

  session: {
    cookieName: "bossraid_sess",
    maxAgeDays: 30,
  },
};

/** Checagem de arranque: falha cedo e explica, em vez de quebrar no meio de uma live. */
export function assertConfig() {
  const faltando = [];
  if (!config.twitch.clientId) faltando.push("TWITCH_CLIENT_ID");
  if (!config.twitch.clientSecret) faltando.push("TWITCH_CLIENT_SECRET");
  if (isProduction && !config.db.url) faltando.push("DATABASE_URL");
  if (isProduction && !process.env.BASE_URL) faltando.push("BASE_URL");
  return faltando;
}
