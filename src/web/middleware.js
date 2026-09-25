import { config } from "../config/env.js";
import { readSession } from "../lib/session.js";

/** Parser de cookie enxuto - o app usa um cookie so, nao vale uma dependencia. */
export function cookies(req, _res, next) {
  req.cookies = {};
  for (const parte of String(req.headers.cookie ?? "").split(";")) {
    const i = parte.indexOf("=");
    if (i < 0) continue;
    const nome = parte.slice(0, i).trim();
    if (nome) req.cookies[nome] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  next();
}

/** Anexa req.session/req.channelId quando o cookie e valido. Nunca bloqueia. */
export async function withSession(req, _res, next) {
  try {
    req.session = await readSession(req.cookies?.[config.session.cookieName]);
    req.channelId = req.session?.channelId ?? null;
  } catch (err) {
    console.error("[sessao] erro ao ler:", err.message);
    req.session = null;
  }
  next();
}

/** Painel: sem sessao, manda pro login (ou 401 se for chamada de API). */
export function requireSession(req, res, next) {
  if (req.session) return next();
  // originalUrl, nao path: dentro de router.use("/api/painel") o path chega sem o prefixo.
  if (req.originalUrl.startsWith("/api/") || req.headers.accept?.includes("application/json")) {
    return res.status(401).json({ ok: false, error: "Faça login com a Twitch para continuar." });
  }
  res.redirect(`/entrar?voltar=${encodeURIComponent(req.originalUrl)}`);
}

/** Erro virando resposta - sem vazar stack pro cliente. */
export function errorHandler(err, req, res, _next) {
  console.error(`[erro] ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({
    ok: false,
    error: err.expose ? err.message : "Algo deu errado do nosso lado. Tenta de novo em instantes.",
  });
}
