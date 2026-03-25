import axios, { AxiosInstance } from "axios";
import axiosRetry from "axios-retry";
import { getValidAccessToken, refreshAccessToken } from "../auth/tokenManager";
import { logger } from "../config/logger";
import { getStoredToken } from "../db";

const LINKEDIN_API_BASE = "https://api.linkedin.com";
const POSTS_ENDPOINT = "/rest/posts";
const USERINFO_ENDPOINT = "/v2/userinfo";

// ─── Tipos de LinkedIn API ────────────────────────────────────────────────────

export interface LinkedInPostRequest {
  author: string;           // urn:li:person:{id}
  commentary: string;
  visibility: "PUBLIC" | "CONNECTIONS";
  distribution: {
    feedDistribution: "MAIN_FEED" | "NONE";
    targetEntities?: string[];
    thirdPartyDistributionChannels?: string[];
  };
  lifecycleState: "PUBLISHED" | "DRAFT";
  isReshareDisabledByAuthor?: boolean;
}

export interface LinkedInPostResponse {
  id: string;  // urn:li:share:{id} o urn:li:ugcPost:{id}
}

export interface LinkedInUserInfo {
  sub: string;   // person id
  name: string;
  given_name: string;
  family_name: string;
  email?: string;
  picture?: string;
}

// ─── Cliente ──────────────────────────────────────────────────────────────────

function createHttpClient(accessToken: string): AxiosInstance {
  const client = axios.create({
    baseURL: LINKEDIN_API_BASE,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
      "LinkedIn-Version": "202406",
    },
    timeout: 15_000,
  });

  axiosRetry(client, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
      const status = error.response?.status;
      // Reintentar en errores de red y 5xx (no en 4xx excepto 429)
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
        message: error.message,
      });
    },
  });

  return client;
}

// ─── API ──────────────────────────────────────────────────────────────────────

/**
 * Obtiene el URN del usuario autenticado (urn:li:person:{id}).
 */
export async function getPersonUrn(): Promise<string> {
  const token = await getValidAccessToken();
  const client = createHttpClient(token);

  const response = await client.get<LinkedInUserInfo>(USERINFO_ENDPOINT);
  const personId = response.data.sub;

  logger.debug("Person URN obtenido", { personId, name: response.data.name });
  return `urn:li:person:${personId}`;
}

/**
 * Publica un post en LinkedIn.
 * Si el token está vencido (401), refresca automáticamente y reintenta una vez.
 *
 * @returns El URN del post creado
 */
export async function publishPost(postText: string): Promise<string> {
  const authorUrn = await getPersonUrn();
  return publishPostAsAuthor(postText, authorUrn);
}

async function publishPostAsAuthor(
  postText: string,
  authorUrn: string,
  isRetry = false
): Promise<string> {
  let token: string;
  try {
    token = await getValidAccessToken();
  } catch (err) {
    throw new Error(`No se pudo obtener un token válido: ${String(err)}`);
  }

  const client = createHttpClient(token);

  const payload: LinkedInPostRequest = {
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

  logger.debug("Publicando post en LinkedIn", {
    author: authorUrn,
    charCount: postText.length,
  });

  try {
    const response = await client.post<LinkedInPostResponse>(POSTS_ENDPOINT, payload);
    const postUrn = response.headers["x-restli-id"] as string ?? response.data?.id ?? "unknown";

    logger.info("Post publicado exitosamente", { postUrn, author: authorUrn });
    return postUrn;
  } catch (error) {
    if (!axios.isAxiosError(error)) throw error;

    const status = error.response?.status;
    const errorData = error.response?.data;

    // Token vencido → refrescar y reintentar UNA vez
    if (status === 401 && !isRetry) {
      logger.warn("Token vencido (401), intentando refresh y reintento...");
      const stored = getStoredToken();
      if (!stored?.refresh_token) {
        throw new Error("Token vencido y no hay refresh token disponible.");
      }

      await refreshAccessToken(stored.refresh_token);
      return publishPostAsAuthor(postText, authorUrn, true);
    }

    const msg = `LinkedIn API error ${status}: ${JSON.stringify(errorData)}`;
    logger.error("Error al publicar post", { status, errorData });
    throw new Error(msg);
  }
}

/**
 * Valida que el token actual tenga los scopes necesarios
 * haciendo una llamada ligera de diagnóstico.
 */
export async function validateTokenScopes(): Promise<{ valid: boolean; name?: string; error?: string }> {
  try {
    const token = await getValidAccessToken();
    const client = createHttpClient(token);
    const response = await client.get<LinkedInUserInfo>(USERINFO_ENDPOINT);
    return { valid: true, name: response.data.name };
  } catch (error) {
    const msg = axios.isAxiosError(error)
      ? `${error.response?.status}: ${JSON.stringify(error.response?.data)}`
      : String(error);
    return { valid: false, error: msg };
  }
}
