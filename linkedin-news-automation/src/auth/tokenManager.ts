import axios from "axios";
import { config } from "../config";
import { logger } from "../config/logger";
import { getStoredToken, saveToken, TokenRecord } from "../db";

const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutos de margen

export interface OAuthTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope: string;
  token_type: string;
}

/**
 * Obtiene un access token válido.
 * Prioridad: 1) ENV vars, 2) SQLite, 3) refresh automático
 */
export async function getValidAccessToken(): Promise<string> {
  // 1. Intentar desde variable de entorno (útil para CI/CD)
  if (config.linkedinAccessToken) {
    logger.debug("Usando access token desde variable de entorno");
    return config.linkedinAccessToken;
  }

  // 2. Intentar desde base de datos
  const stored = getStoredToken();
  if (stored) {
    const expiresAt = new Date(stored.expires_at).getTime();
    const now = Date.now();

    if (expiresAt - now > TOKEN_EXPIRY_BUFFER_MS) {
      logger.debug("Usando access token almacenado en DB", {
        expiresAt: stored.expires_at,
      });
      return stored.access_token;
    }

    // Token vencido → intentar refresh
    if (stored.refresh_token) {
      logger.info("Access token vencido, intentando refresh...");
      return refreshAccessToken(stored.refresh_token);
    }
  }

  throw new Error(
    "No hay access token disponible. Ejecutá `npm run get-token` para autenticarte."
  );
}

/**
 * Refresca el access token usando el refresh token.
 * Llama a LinkedIn y persiste el nuevo token en DB.
 */
export async function refreshAccessToken(refreshToken: string): Promise<string> {
  try {
    const response = await axios.post<OAuthTokenResponse>(
      LINKEDIN_TOKEN_URL,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.linkedinClientId,
        client_secret: config.linkedinClientSecret,
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    const tokenData = response.data;
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

    const record: TokenRecord = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token ?? refreshToken,
      expires_at: expiresAt,
      scope: tokenData.scope,
    };

    saveToken(record);

    logger.info("Token refrescado exitosamente", { expiresAt, scope: tokenData.scope });
    return tokenData.access_token;
  } catch (error) {
    const msg = axios.isAxiosError(error)
      ? `${error.response?.status} - ${JSON.stringify(error.response?.data)}`
      : String(error);
    logger.error("Error al refrescar token", { error: msg });
    throw new Error(`Refresh token fallido: ${msg}`);
  }
}

/**
 * Intercambia un authorization code por access + refresh tokens.
 * Usado en el flujo inicial de autenticación (scripts/getToken.ts).
 */
export async function exchangeCodeForTokens(code: string): Promise<OAuthTokenResponse> {
  const response = await axios.post<OAuthTokenResponse>(
    LINKEDIN_TOKEN_URL,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.linkedinRedirectUri,
      client_id: config.linkedinClientId,
      client_secret: config.linkedinClientSecret,
    }),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }
  );

  const tokenData = response.data;
  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

  saveToken({
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: expiresAt,
    scope: tokenData.scope,
  });

  logger.info("Tokens obtenidos y guardados", {
    expiresAt,
    scope: tokenData.scope,
    hasRefreshToken: !!tokenData.refresh_token,
  });

  return tokenData;
}

/**
 * Construye la URL de autorización OAuth 2.0 para LinkedIn.
 */
export function buildAuthorizationUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.linkedinClientId,
    redirect_uri: config.linkedinRedirectUri,
    state,
    scope: "openid profile w_member_social",
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
}
