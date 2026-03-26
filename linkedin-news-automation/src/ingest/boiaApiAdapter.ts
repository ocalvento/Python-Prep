/**
 * boiaApiAdapter
 *
 * Consume candidatos desde el endpoint REST interno de BOIA.
 *
 * GET {BOIA_API_URL}/candidates?status=ready&limit=50
 * Headers:
 *   Authorization: Bearer {BOIA_API_KEY}
 *   Accept: application/json
 *
 * Se espera respuesta: { items: RawBoiaCandidate[] } o RawBoiaCandidate[]
 *
 * Configurable en:
 *   BOIA_API_URL  - URL base del API de BOIA (sin trailing slash)
 *   BOIA_API_KEY  - API key para autenticación
 *   BOIA_API_LIMIT - máximo de candidatos a pedir (default: 50)
 */

import axios from "axios";
import { config } from "../config";
import { logger } from "../config/logger";
import { BoidaCandidateSchema, BoiaCandidate, buildBoiaCandidate } from "./types";

const CANDIDATES_ENDPOINT = "/candidates";

export async function fetchFromApi(): Promise<BoiaCandidate[]> {
  if (!config.boiaApiUrl) {
    throw new Error("BOIA_API_URL no está configurado");
  }

  const url = `${config.boiaApiUrl}${CANDIDATES_ENDPOINT}`;

  logger.debug("Consultando API de BOIA", { url });

  let raw: unknown[];

  try {
    const response = await axios.get<unknown>(url, {
      headers: {
        Authorization: config.boiaApiKey ? `Bearer ${config.boiaApiKey}` : undefined,
        Accept: "application/json",
      },
      params: {
        status: "ready",
        limit: config.boiaApiLimit,
      },
      timeout: 15_000,
    });

    // Soportar ambos formatos: array directo o { items: [...] }
    const data = response.data;
    if (Array.isArray(data)) {
      raw = data;
    } else if (
      data !== null &&
      typeof data === "object" &&
      Array.isArray((data as Record<string, unknown>).items)
    ) {
      raw = (data as Record<string, unknown>).items as unknown[];
    } else {
      throw new Error(
        `Respuesta inesperada del API BOIA: se esperaba array o { items: [...] }, recibido: ${typeof data}`
      );
    }
  } catch (err) {
    if (axios.isAxiosError(err)) {
      throw new Error(
        `Error al consultar API BOIA: HTTP ${err.response?.status} — ${JSON.stringify(err.response?.data)}`
      );
    }
    throw err;
  }

  const candidates: BoiaCandidate[] = [];

  for (let i = 0; i < raw.length; i++) {
    const result = BoidaCandidateSchema.safeParse(raw[i]);

    if (!result.success) {
      logger.warn(`Candidato BOIA API ${i} inválido, saltando`, {
        errors: result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`),
      });
      continue;
    }

    candidates.push(buildBoiaCandidate(result.data));
  }

  logger.info("Candidatos BOIA leídos desde API", {
    url,
    total: raw.length,
    valid: candidates.length,
  });

  return candidates;
}
