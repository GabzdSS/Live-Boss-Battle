import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { query, tx, close } from "./index.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Migrations sao arquivos .sql numerados, aplicados uma vez so, em ordem,
 * cada um dentro de uma transacao. O historico fica no proprio banco, entao
 * rodar duas vezes nao quebra nada.
 */
export async function migrate({ silent = false } = {}) {
  await query(`create table if not exists schema_migrations (
    name       text primary key,
    applied_at timestamptz not null default now()
  )`);

  const { rows } = await query("select name from schema_migrations");
  const aplicadas = new Set(rows.map((r) => r.name));
  const arquivos = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

  const novas = arquivos.filter((f) => !aplicadas.has(f));
  if (novas.length === 0) {
    if (!silent) console.log(`[db] esquema em dia (${arquivos.length} migrations)`);
    return [];
  }

  for (const arquivo of novas) {
    const sql = fs.readFileSync(path.join(DIR, arquivo), "utf-8");
    await tx(async (t) => {
      await t.exec(sql);
      await t.query("insert into schema_migrations (name) values ($1)", [arquivo]);
    });
    console.log(`[db] aplicada: ${arquivo}`);
  }
  return novas;
}

// `node src/db/migrate.js` roda direto pela linha de comando.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then(() => close())
    .catch((err) => {
      console.error("[db] falha na migration:", err.message);
      process.exit(1);
    });
}
