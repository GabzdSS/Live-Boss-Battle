import express from "express";
import path from "path";
import { config } from "../../config/env.js";
import * as channels from "../../repos/channels.js";

export const router = express.Router();

const paginas = path.join(config.root, "public");

/**
 * Paginas abertas ao publico. O overlay se protege por um token secreto na
 * URL, que so a streamer ve (o socket confere o mesmo token antes de entrar
 * na sala do canal). O hall da fama em /c/<slug> chega com a premiacao.
 */
router.get("/overlay/:token", async (req, res) => {
  const canal = await channels.findByOverlayToken(req.params.token);
  if (!canal) return res.status(404).send("Overlay não encontrado. Copie a URL de novo no seu painel.");
  res.sendFile(path.join(paginas, "overlay.html"));
});
