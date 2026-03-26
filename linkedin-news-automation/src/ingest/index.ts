/**
 * Factory de adapters BOIA.
 *
 * Elige la fuente de datos según BOIA_SOURCE:
 *   json (default) → boiaJsonAdapter
 *   api            → boiaApiAdapter
 *   db             → boiaDbAdapter
 */

import { config } from "../config";
import { logger } from "../config/logger";
import { BoiaCandidate } from "./types";
import { fetchFromJson } from "./boiaJsonAdapter";
import { fetchFromApi } from "./boiaApiAdapter";
import { fetchFromDb } from "./boiaDbAdapter";

export type BoiaSource = "json" | "api" | "db";

export async function fetchBoidaCandidates(): Promise<BoiaCandidate[]> {
  const source = config.boiaSource;
  logger.info("Obteniendo candidatos BOIA", { source });

  switch (source) {
    case "json":
      return fetchFromJson();
    case "api":
      return fetchFromApi();
    case "db":
      return fetchFromDb();
    default:
      throw new Error(
        `BOIA_SOURCE inválido: "${source}". Valores aceptados: json | api | db`
      );
  }
}

export { BoiaCandidate } from "./types";
