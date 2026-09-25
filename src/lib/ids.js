import crypto from "crypto";

/** Token opaco pra URL (overlay, sessao): aleatorio e sem caractere problematico. */
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString("base64url");

/**
 * Slug publico a partir do login da Twitch. Login de Twitch ja e [a-z0-9_],
 * mas o slug e o que aparece na URL do album - passa pela peneira mesmo assim.
 */
export function slugify(texto) {
  const base = String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || `canal-${randomToken(4)}`;
}

/** Login de Twitch valido, sem o @ que as pessoas digitam no chat. */
export function cleanLogin(valor) {
  return String(valor ?? "").trim().replace(/^@+/, "").toLowerCase();
}

export const isValidLogin = (login) => /^[a-z0-9_]{1,25}$/.test(login);
