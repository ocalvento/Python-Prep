/**
 * boiaJsonAdapter
 *
 * Lee candidatos desde un archivo JSON exportado por BOIA.
 * Es la fuente recomendada para MVP y entornos sin API interna activa.
 *
 * Formato esperado: array de RawBoiaCandidate[]
 * Ruta configurada en BOIA_JSON_PATH (default: ./inputs/boia_candidates.json)
 */

import * as fs from "fs";
import { config } from "../config";
import { logger } from "../config/logger";
import { BoidaCandidateSchema, BoiaCandidate, buildBoiaCandidate } from "./types";

export async function fetchFromJson(filePath?: string): Promise<BoiaCandidate[]> {
  const targetPath = filePath ?? config.boiaJsonPath;

  if (!fs.existsSync(targetPath)) {
    throw new Error(`Archivo BOIA no encontrado: ${targetPath}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(targetPath, "utf-8"));
  } catch (err) {
    throw new Error(`Error al parsear ${targetPath}: ${String(err)}`);
  }

  if (!Array.isArray(raw)) {
    throw new Error("El archivo BOIA debe contener un array JSON");
  }

  const candidates: BoiaCandidate[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const result = BoidaCandidateSchema.safeParse(raw[i]);

    if (!result.success) {
      logger.warn(`Candidato BOIA ${i} inválido, saltando`, {
        index: i,
        id: (raw[i] as Record<string, unknown>)?.id,
        errors: result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`),
      });
      continue;
    }

    const data = result.data;

    if (seenIds.has(data.id)) {
      logger.warn(`ID duplicado dentro del archivo BOIA, saltando`, { id: data.id, index: i });
      continue;
    }

    seenIds.add(data.id);
    candidates.push(buildBoiaCandidate(data));
  }

  logger.info("Candidatos BOIA leídos desde JSON", {
    path: targetPath,
    total: raw.length,
    valid: candidates.length,
    invalid: raw.length - candidates.length,
  });

  return candidates;
}
