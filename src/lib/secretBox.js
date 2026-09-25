import crypto from "crypto";
import { config } from "../config/env.js";

/**
 * Cifra os tokens da Twitch antes de gravar no banco.
 *
 * Nao e enfeite: o access token da streamer permite mexer nas recompensas do
 * canal dela e falar no chat em nome dela. Um dump de banco vazado (backup
 * perdido, credencial do Postgres exposta) nao pode virar controle das contas
 * dos clientes. A chave mora no ambiente, nunca no banco - quem rouba um sem
 * o outro nao tem nada.
 *
 * AES-256-GCM: cifra e autentica. Se alguem mexer num byte do texto cifrado,
 * decifrar falha em vez de devolver lixo silencioso.
 */

const ALGO = "aes-256-gcm";

function key() {
  const raw = Buffer.from(config.tokenKey, "base64");
  if (raw.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY precisa ser 32 bytes em base64 (npm run gerar-chaves)");
  }
  return raw;
}

/** Devolve "v1.<iv>.<tag>.<cifra>", tudo em base64url. */
export function encrypt(plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const cifra = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), cifra.toString("base64url")].join(".");
}

export function decrypt(stored) {
  if (stored == null) return null;
  const [versao, iv, tag, cifra] = String(stored).split(".");
  if (versao !== "v1" || !iv || !tag || !cifra) throw new Error("Texto cifrado em formato desconhecido");
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(cifra, "base64url")), decipher.final()]).toString("utf8");
}

/** Comparacao em tempo constante (nao vaza o tamanho do prefixo igual). */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ""));
  const bufB = Buffer.from(String(b ?? ""));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}
