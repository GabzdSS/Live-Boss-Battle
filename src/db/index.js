import fs from "fs";
import { config } from "../config/env.js";

/**
 * Uma interface de banco pros dois mundos:
 *
 *   producao  -> Postgres de verdade (Neon/Railway/VPS) via `pg`
 *   dev local -> PGlite (o mesmo Postgres compilado pra WASM), num diretorio
 *                dentro de data/ - sem Docker, sem instalar nada, mesmo SQL
 *
 * Todo mundo no app usa so `query` e `tx`. Ninguem importa `pg` ou PGlite
 * direto - assim trocar de destino e mudar DATABASE_URL, nada mais.
 */

let driver = null;
let ready = null;

async function startPostgres(url) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString: url,
    // provedores gerenciados (Neon, Railway, Supabase) exigem TLS
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    max: Number(process.env.DB_POOL_MAX) || 10,
  });
  await pool.query("select 1");
  return {
    kind: "postgres",
    query: (sql, params) => pool.query(sql, params),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn({
        query: (sql, params) => client.query(sql, params),
        exec: (sql) => client.query(sql),
      });
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function startPglite(dir) {
  const { PGlite } = await import("@electric-sql/pglite");
  if (!dir.startsWith("memory://")) fs.mkdirSync(dir, { recursive: true });

  let db;
  try {
    db = await PGlite.create({ dataDir: dir });
  } catch (err) {
    // O Postgres em WASM nao tem recuperacao de crash: se o processo morrer
    // no meio de uma escrita (kill -9, fechar o terminal a forca), o diretorio
    // fica sem conserto. Em producao isso nao existe - la e Postgres de
    // verdade. Aqui o certo e falar a verdade e dizer como sair.
    throw new Error(
      [
        `Banco de dev nao abriu (${dir}).`,
        "Isso costuma acontecer quando o servidor foi encerrado a forca.",
        `Saida: apague a pasta ${dir} e rode a importacao/migrations de novo.`,
        `Causa original: ${err.message?.slice(0, 200)}`,
      ].join("\n")
    );
  }
  const normalize = (res) => ({ ...res, rowCount: res.affectedRows ?? res.rows?.length ?? 0 });
  return {
    kind: "pglite",
    query: async (sql, params) => normalize(await db.query(sql, params)),
    tx: (fn) =>
      db.transaction((t) =>
        fn({
          query: async (sql, params) => normalize(await t.query(sql, params)),
          // query() do PGlite e prepared statement: nao aceita varios comandos
          // num arquivo so (caso das migrations). exec() aceita.
          exec: (sql) => t.exec(sql),
        })
      ),
    close: () => db.close(),
  };
}

export function connect() {
  if (!ready) {
    ready = (async () => {
      driver = config.db.url ? await startPostgres(config.db.url) : await startPglite(config.db.localDir);
      console.log(
        driver.kind === "postgres"
          ? "[db] Postgres conectado"
          : `[db] PGlite local em ${config.db.localDir} (sem DATABASE_URL - modo dev)`
      );
      return driver;
    })();
  }
  return ready;
}

export async function query(sql, params = []) {
  const db = await connect();
  return db.query(sql, params);
}

/** Primeira linha do resultado, ou null. */
export async function one(sql, params = []) {
  const { rows } = await query(sql, params);
  return rows[0] ?? null;
}

export async function many(sql, params = []) {
  const { rows } = await query(sql, params);
  return rows;
}

/** Tudo ou nada: se `fn` lancar, nada e gravado. */
export async function tx(fn) {
  const db = await connect();
  return db.tx(fn);
}

export async function close() {
  if (!ready) return;
  const db = await ready;
  await db.close();
  ready = null;
  driver = null;
}
