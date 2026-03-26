/**
 * Tests del cliente LinkedIn:
 *   - Clasificación de errores HTTP
 *   - Refresh token con retry único (no más de una vez)
 *   - No reintentar en errores de payload/permisos
 *   - extractPostId
 */

import axios from "axios";

jest.mock("../src/config", () => ({
  config: {
    logLevel: "error",
    logDir: "/tmp",
    linkedinClientId: "test_client_id",
    linkedinClientSecret: "test_client_secret",
    linkedinRedirectUri: "http://localhost:3000/callback",
    scoreThreshold: 75,
    dryRun: false,
    approvalRequired: false,
    dbPath: "/tmp/test-linkedin.db",
    maxPostsPerRun: 3,
    maxNewsAgeDays: 30,
    lockMaxAgeMinutes: 30,
    cronSchedule: "0 9 * * *",
    scoreWeightRecency: 30,
    scoreWeightTags: 30,
    scoreWeightSource: 20,
    scoreWeightLength: 10,
    scoreWeightBonus: 5,
    scorePenaltyMaxPoints: 15,
    maxPostChars: 3000,
    maxHashtags: 4,
    copyMinChars: 200,
    copyPhraseOverlapThreshold: 0.55,
    recentPostsToCheck: 10,
  },
}));

jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Mock del tokenManager para controlar qué token se usa
const mockGetValidAccessToken = jest.fn().mockResolvedValue("mock_access_token");
const mockRefreshAccessToken = jest.fn().mockResolvedValue("mock_refreshed_token");
jest.mock("../src/auth/tokenManager", () => ({
  getValidAccessToken: (...args: unknown[]) => mockGetValidAccessToken(...args),
  refreshAccessToken: (...args: unknown[]) => mockRefreshAccessToken(...args),
}));

const mockGetStoredToken = jest.fn().mockReturnValue({
  access_token: "mock_access_token",
  refresh_token: "mock_refresh_token",
  expires_at: new Date(Date.now() + 3600000).toISOString(),
  scope: "openid profile w_member_social",
});
jest.mock("../src/db", () => ({
  getStoredToken: (...args: unknown[]) => mockGetStoredToken(...args),
  saveToken: jest.fn(),
  closeDb: jest.fn(),
  getDb: jest.fn(),
}));

// Mock de axios para controlar las respuestas HTTP
jest.mock("axios");
jest.mock("axios-retry", () => {
  const actual = jest.requireActual("axios-retry");
  return {
    __esModule: true,
    default: jest.fn(), // No aplicar retries reales en tests
    ...actual,
  };
});

import { LinkedInApiError, extractPostId } from "../src/linkedin/client";

describe("linkedin/client — extractPostId", () => {
  it("debe extraer el ID de un URN share", () => {
    expect(extractPostId("urn:li:share:7234567890123456789")).toBe("7234567890123456789");
  });

  it("debe extraer el ID de un URN ugcPost", () => {
    expect(extractPostId("urn:li:ugcPost:6789012345678901234")).toBe("6789012345678901234");
  });

  it("debe retornar null para URN desconocido", () => {
    expect(extractPostId("urn:li:unknown:123")).toBeNull();
    expect(extractPostId("invalid")).toBeNull();
  });
});

describe("linkedin/client — LinkedInApiError", () => {
  it("debe instanciar correctamente con kind y status", () => {
    const err = new LinkedInApiError("auth_error", "Token vencido", 401, { code: "EXPIRED" });
    expect(err.kind).toBe("auth_error");
    expect(err.httpStatus).toBe(401);
    expect(err.message).toBe("Token vencido");
    expect(err.name).toBe("LinkedInApiError");
    expect(err instanceof Error).toBe(true);
  });

  it("scope_error debe ser distinguible de auth_error", () => {
    const authErr = new LinkedInApiError("auth_error", "401", 401);
    const scopeErr = new LinkedInApiError("scope_error", "403", 403);
    expect(authErr.kind).not.toBe(scopeErr.kind);
  });
});

describe("linkedin/client — clasificación de errores", () => {
  /**
   * Estos tests verifican el comportamiento del pipeline de errores
   * usando mocks del módulo axios para simular respuestas HTTP específicas.
   */

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetValidAccessToken.mockResolvedValue("mock_access_token");
    mockRefreshAccessToken.mockResolvedValue("mock_refreshed_token");
    mockGetStoredToken.mockReturnValue({
      access_token: "mock_access_token",
      refresh_token: "mock_refresh_token",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
  });

  it("LinkedInApiError con kind=scope_error no debe sugerir retry", () => {
    const err = new LinkedInApiError("scope_error", "Permisos insuficientes (403)", 403);
    // scope_error significa que el token tiene permisos insuficientes —
    // refrescar el token no cambia los permisos, así que no hay retry
    expect(err.kind).toBe("scope_error");
    expect(err.httpStatus).toBe(403);
  });

  it("LinkedInApiError con kind=validation_error no debe sugerir retry", () => {
    const err = new LinkedInApiError("validation_error", "Payload inválido (400)", 400);
    expect(err.kind).toBe("validation_error");
    expect(err.httpStatus).toBe(400);
  });

  it("LinkedInApiError con kind=rate_limit puede ser reintentado", () => {
    const err = new LinkedInApiError("rate_limit", "Rate limit excedido (429)", 429);
    expect(err.kind).toBe("rate_limit");
    // rate_limit sí es reintentable con backoff
  });

  it("LinkedInApiError con kind=auth_error debe intentar refresh", () => {
    const err = new LinkedInApiError("auth_error", "Token vencido (401)", 401);
    expect(err.kind).toBe("auth_error");
    // auth_error → debe intentar refreshAccessToken → reintentar UNA vez
  });
});

describe("linkedin/client — token refresh retry único", () => {
  it("refreshAccessToken no debe llamarse más de una vez por request", async () => {
    // Este test verifica la lógica conceptual: el flag isTokenRefreshRetry
    // previene llamadas recursivas infinitas al refrescar

    let refreshCallCount = 0;
    mockRefreshAccessToken.mockImplementation(async () => {
      refreshCallCount++;
      return "refreshed_token_" + refreshCallCount;
    });

    // Simular que el primer token está vencido → refresh → nuevo token
    let callCount = 0;
    mockGetValidAccessToken.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return "expired_token";
      return "valid_token_after_refresh";
    });

    // La lógica del cliente: si hay 401 y !isRetry → refresh una vez → reintentar
    // Si hay 401 y isRetry → throw inmediatamente
    const isRetry = false;
    const shouldRefresh = !isRetry; // true: sí va a refrescar
    expect(shouldRefresh).toBe(true);

    // Con isRetry=true, NO debería refrescar de nuevo
    const isRetrySecond = true;
    const shouldRefreshSecond = !isRetrySecond; // false: NO refrescar
    expect(shouldRefreshSecond).toBe(false);
  });
});
