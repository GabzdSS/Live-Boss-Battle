import express from "express";
import path from "path";
import { config, isProduction } from "../config/env.js";
import { cookies, withSession, requireSession, errorHandler } from "./middleware.js";
import { router as authRouter } from "./routes/auth.js";
import { router as painelRouter } from "./routes/painel.js";
import { router as publicoRouter } from "./routes/publico.js";
import { router as assinaturaRouter } from "./routes/painelAssinatura.js";
import { router as webhooksRouter } from "./routes/webhooks.js";

export async function criarApp() {
  const app = express();

  // Atras de proxy (Fly/Cloudflare) pra req.ip e cookie secure enxergarem a
  // verdade em vez do proxy.
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));
  app.use(cookies);
  app.use(withSession);

  app.get("/saude", (_req, res) => res.json({ ok: true, em: new Date().toISOString() }));

  app.use(authRouter);
  app.use(painelRouter);
  app.use(assinaturaRouter);
  app.use(webhooksRouter);
  app.use(publicoRouter);

  if (!isProduction) {
    const { router: devRouter } = await import("./routes/dev.js");
    app.use(devRouter);
  }

  const paginas = path.join(config.root, "public", "app");
  // A vitrine chega na etapa 6. Ate la, quem nao entrou vai direto pro login.
  app.get("/", (req, res) => res.redirect(req.session ? "/painel" : "/entrar"));

  app.get("/api/preco", (_req, res) => res.json({ preco: Number(process.env.PRECO_MENSAL || 19.9) }));
  app.get("/entrar", (req, res) =>
    req.session ? res.redirect("/painel") : res.sendFile(path.join(paginas, "entrar.html"))
  );
  app.get("/painel", requireSession, (_req, res) => res.sendFile(path.join(paginas, "painel.html")));
  app.get("/painel/assinatura", requireSession, (_req, res) => res.sendFile(path.join(paginas, "assinatura.html")));

  app.use(express.static(path.join(config.root, "public")));

  app.use((req, res) => res.status(404).json({ ok: false, error: `Rota não encontrada: ${req.path}` }));
  app.use(errorHandler);

  return app;
}
