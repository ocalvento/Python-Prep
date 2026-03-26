import axios, { AxiosInstance } from "axios";
import axiosRetry from "axios-retry";
import { getValidAccessToken, refreshAccessToken } from "../auth/tokenManager";
import { logger } from "../config/logger";
import { getStoredToken } from "../db";
import type { FailureReason } from "../db";

const LINKEDIN_API_BASE = "https://api.linkedin.com";
const POSTS_ENDPOINT = "/rest/posts";
const USERINFO_ENDPOINT = "/v2/userinfo";

// ─── Tipos de error tipados ───────────────────────────────────────────────────

export class LinkedInApiError extends Error {
  constructor(
    public readonly kind: FailureReason,
    message: string,
    public readonly httpStatus?: number,
    public readonly responseData?: unknown
  ) {
    super(message);
    this.name = "LinkedInApiError";
  }
}

/**
 * Clasifica un error HTTP de LinkedIn en una categoría semántica.
 * Esto determina si vale la pena reintentar y cómo registrarlo.
 */
function classifyHttpError(status: number, data: unknown): FailureReason {
  switch (status) {
    case 401:
      return "auth_error";
    case 403:
      return "scope_error"; // Permisos insuficientes — no hay retry que lo resuelva
    case 400:
    case 422:
      return "validation_error"; // Payload inválido — reintentar no cambia nada
    case 429:
      return "rate_limit";
    default:
      if (status >= 500) return "network_error";
      return "unknown";
  }
}

// ─── HTTP client ──────────────────────────────────────────────────────────────

function createHttpClient(accessToken: string): AxiosInstance {
  const client = axios.create({
    baseURL: LINKEDIN_API_BASE,
    headers: {
      Authorization: `Bearer ${maskToken(accessToken)}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
      "LinkedIn-Version": "202406",
    },
    timeout: 15_000,
  });

  // Reemplazar el header Authorization con el token real (sin mascara)
  client.defaults.headers.common["Authorization"] = `Bearer ${accessToken}`;

  axiosRetry(client, {
    retries: 3,
    retryDelay: (retryCount) => axiosRetry.exponentialDelay(retryCount) + Math.random() * 500,
    retryCondition: (error) => {
      const status = error.response?.status;

      // NO reintentar en errores de cliente que no cambiarán con un reintento
      if (status === 400 || status === 403 || status === 422) return false;

      // SÍ reintentar en: errores de red, rate limit, errores de servidor
      return (
        axiosRetry.isNetworkOrIdempotentRequestError(error) ||
        status === 429 ||
        (!!status && status >= 500)
      );
    },
    onRetry: (retryCount, error) => {
      logger.warn("Reintentando request a LinkedIn", {
        retryCount,
        status: error.response?.status,
        kind: error.response ? classifyHttpError(error.response.status, null) : "network_error",
      });
    },
  });

  return client;
}

// ─── API pública ──────────────────────────────────────────────────────────────

export async function getPersonUrn(): Promise<string> {
  const token = await getValidAccessToken();
  const client = createHttpClient(token);

  try {
    const response = await client.get<{ sub: string; name: string }>(USERINFO_ENDPOINT);
    logger.debug("Person URN obtenido", { name: response.data.name });
    return `urn:li:person:${response.data.sub}`;
  } catch (error) {
    if (!axios.isAxiosError(error)) throw error;
    const status = error.response?.status ?? 0;
    const kind = classifyHttpError(status, error.response?.data);
    throw new LinkedInApiError(kind, `No se pudo obtener el person URN: HTTP ${status}`, status);
  }
}

/**
 * Publica un post en LinkedIn.
 *
 * Política de refresh/retry:
 *   - Error 401 → refrescar token UNA vez → reintentar UNA vez
 *   - Error 403 → lanzar LinkedInApiError(scope_error) — no hay retry
 *   - Error 400/422 → lanzar LinkedInApiError(validation_error) — no hay retry
 *   - Error 429/5xx → axios-retry maneja automáticamente (max 3 intentos)
 *
 * @returns El URN del post creado
 */
export async function publishPost(postText: string): Promise<string> {
  const authorUrn = await getPersonUrn();
  return publishPostWithAuthor(postText, authorUrn, false);
}

async function publishPostWithAuthor(
  postText: string,
  authorUrn: string,
  isTokenRefreshRetry: boolean
): Promise<string> {
  const token = await getValidAccessToken();
  const client = createHttpClient(token);

  const payload = {
    author: authorUrn,
    commentary: postText,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };

  logger.debug("Enviando post a LinkedIn", {
    author: authorUrn,
    charCount: postText.length,
    isRetry: isTokenRefreshRetry,
  });

  try {
    const response = await client.post(POSTS_ENDPOINT, payload);

    // LinkedIn devuelve el URN del post en el header x-restli-id
    const postUrn =
      (response.headers["x-restli-id"] as string | undefined) ??
      (response.data as { id?: string })?.id ??
      "unknown";

    logger.info("Post publicado exitosamente", {
      postUrn,
      author: authorUrn,
      httpStatus: response.status,
    });

    return postUrn;
  } catch (error) {
    if (!axios.isAxiosError(error)) throw error;

    const status = error.response?.status ?? 0;
    const responseData = error.response?.data;
    const kind = classifyHttpError(status, responseData);

    // Loguear sin exponer el payload completo (puede contener contenido del post)
    logger.error("Error al publicar en LinkedIn", {
      httpStatus: status,
      kind,
      errorCode: (responseData as Record<string, unknown>)?.errorDetailType,
      message: (responseData as Record<string, unknown>)?.message,
    });

    // Token vencido → refrescar una sola vez y reintentar
    if (kind === "auth_error" && !isTokenRefreshRetry) {
      const stored = getStoredToken();
      if (!stored?.refresh_token) {
        throw new LinkedInApiError(
          "auth_error",
          "Token vencido (401) y no hay refresh token almacenado. Ejecutá npm run get-token.",
          status
        );
      }

      logger.info("Refrescando token y reintentando publicación...");
      await refreshAccessToken(stored.refresh_token);
      return publishPostWithAuthor(postText, authorUrn, true);
    }

    // Para scope_error y validation_error, fallar de inmediato (no hay retry que ayude)
    if (kind === "scope_error") {
      throw new LinkedInApiError(
        kind,
        "Permisos insuficientes (403). Verificá que la app tenga el scope w_member_social activo.",
        status,
        responseData
      );
    }

    if (kind === "validation_error") {
      throw new LinkedInApiError(
        kind,
        `Payload inválido (${status}). El contenido puede tener caracteres no permitidos o superar límites.`,
        status,
        responseData
      );
    }

    throw new LinkedInApiError(
      kind,
      `LinkedIn API error ${status}: ${(responseData as Record<string, unknown>)?.message ?? "Unknown error"}`,
      status,
      responseData
    );
  }
}

export async function validateTokenScopes(): Promise<{
  valid: boolean;
  name?: string;
  error?: string;
  kind?: FailureReason;
}> {
  try {
    const token = await getValidAccessToken();
    const client = createHttpClient(token);
    const response = await client.get<{ sub: string; name: string }>(USERINFO_ENDPOINT);
    return { valid: true, name: response.data.name };
  } catch (error) {
    if (error instanceof LinkedInApiError) {
      return { valid: false, error: error.message, kind: error.kind };
    }
    const msg = axios.isAxiosError(error)
      ? `HTTP ${error.response?.status}: ${JSON.stringify(error.response?.data)}`
      : String(error);
    return { valid: false, error: msg };
  }
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

/** Enmascara un token para logs: muestra solo los primeros y últimos 4 chars */
function maskToken(token: string): string {
  if (token.length <= 12) return "***";
  return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
}

/** Extrae el ID numérico de un URN de LinkedIn */
export function extractPostId(urn: string): string | null {
  const match = urn.match(/urn:li:(?:share|ugcPost):(\d+)/);
  return match?.[1] ?? null;
}
