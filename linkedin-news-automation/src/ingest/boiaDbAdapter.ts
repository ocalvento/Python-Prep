/**
 * boiaDbAdapter
 *
 * Lee candidatos directamente desde la base de datos SQLite de BOIA.
 * Útil cuando el sistema LinkedIn corre en la misma instancia que BOIA
 * o tiene acceso al mismo archivo de base de datos.
 *
 * Configurable en:
 *   BOIA_DB_PATH   - ruta al SQLite de BOIA
 *   BOIA_DB_TABLE  - nombre de la tabla de candidatos (default: candidates)
 *
 * Columnas esperadas en la tabla (nombres snake_case de RawBoiaCandidate):
 *   id, title, summary, source_url, published_at, organism, category,
 *   tags (TEXT — JSON array serializado), boia_relevance_score,
 *   why_it_matters, affected_audience (TEXT — JSON array serializado),
 *   linkedin_angle (TEXT, nullable)
 *
 * Solo lee registros con status = 'ready' o sin columna status.
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import { config } from "../config";
import { logger } from "../config/logger";
import { BoidaCandidateSchema, BoiaCandidate, buildBoiaCandidate, RawBoiaCandidate } from "./types";

export function fetchFromDb(dbPath?: string, tableName?: string): BoiaCandidate[] {
  const path = dbPath ?? config.boiaDbPath;
  const table = tableName ?? config.boiaDbTable;

  if (!path) throw new Error("BOIA_DB_PATH no está configurado");
  if (!fs.existsSync(path)) throw new Error(`Base de datos BOIA no encontrada: ${path}`);

  const db = new Database(path, { readonly: true });

  let rows: Record<string, unknown>[];

  try {
    // Detectar si existe columna status para filtrar solo registros listos
    const columns = db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as { name: string }[];
    const hasStatus = columns.some((c) => c.name === "status");

    const query = hasStatus
      ? `SELECT * FROM ${table} WHERE status = 'ready' ORDER BY published_at DESC LIMIT 100`
      : `SELECT * FROM ${table} ORDER BY published_at DESC LIMIT 100`;

    rows = db.prepare(query).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }

  const candidates: BoiaCandidate[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Deserializar campos JSON almacenados como TEXT
    const parsed: RawBoiaCandidate = {
      id: String(row["id"] ?? ""),
      title: String(row["title"] ?? ""),
      summary: String(row["summary"] ?? ""),
      source_url: String(row["source_url"] ?? ""),
      published_at: String(row["published_at"] ?? ""),
      organism: String(row["organism"] ?? ""),
      category: String(row["category"] ?? ""),
      tags: safeJsonArray(row["tags"]),
      boia_relevance_score: Number(row["boia_relevance_score"] ?? 0),
      why_it_matters: String(row["why_it_matters"] ?? ""),
      affected_audience: safeJsonArray(row["affected_audience"]),
      linkedin_angle:
        row["linkedin_angle"] != null ? String(row["linkedin_angle"]) : undefined,
    };

    const result = BoidaCandidateSchema.safeParse(parsed);

    if (!result.success) {
      logger.warn(`Fila DB BOIA ${i} inválida, saltando`, {
        id: row["id"],
        errors: result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`),
      });
      continue;
    }

    candidates.push(buildBoiaCandidate(result.data));
  }

  logger.info("Candidatos BOIA leídos desde DB", {
    path,
    table,
    total: rows.length,
    valid: candidates.length,
  });

  return candidates;
}

function safeJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}
