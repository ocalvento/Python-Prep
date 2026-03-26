/**
 * Tests para los tres adaptadores de BOIA:
 * - boiaJsonAdapter: lectura desde archivo JSON
 * - boiaApiAdapter: consulta a endpoint REST
 * - boiaDbAdapter: lectura desde SQLite de BOIA
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Database from "better-sqlite3";

jest.mock("../src/config", () => ({
  config: {
    boiaJsonPath: "/tmp/boia-test-default.json",
    boiaApiUrl: "http://localhost:9999",
    boiaApiKey: "test-key",
    boiaApiLimit: 50,
    boiaDbPath: undefined,
    boiaDbTable: "candidates",
    logLevel: "error",
    logDir: "/tmp",
  },
}));
jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ─── Fixture compartido ───────────────────────────────────────────────────────

const VALID_RAW = {
  id: "boia-adapter-001",
  title: "BCRA establece nuevos requisitos de liquidez para PSP en Argentina",
  summary:
    "El Banco Central publicó la Comunicación A 8123 estableciendo que los PSP deberán " +
    "mantener encajes mínimos del 30% sobre el saldo de fondos de clientes en cuentas de pago. " +
    "La norma entra en vigencia el 1 de julio de 2026 y aplica a todos los PSP autorizados.",
  source_url: "https://bcra.gob.ar/test-adapter",
  published_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
  organism: "BCRA",
  category: "regulacion_financiera",
  tags: ["psp", "liquidez", "regulacion"],
  boia_relevance_score: 85,
  why_it_matters:
    "Los 180 PSP habilitados deberán revisar su estructura de capital antes del 1 de julio. " +
    "Para muchos, el 30% de encaje implica inmovilizar capital. Las fintechs deberán " +
    "adaptar su modelo operativo con impacto directo en la tesorería.",
  affected_audience: ["fintechs", "psp", "compliance"],
  linkedin_angle: "Las reglas de liquidez para PSP cambian el modelo operativo de las fintechs.",
};

const INVALID_RAW = {
  id: "bad-001",
  title: "Corto", // demasiado corto
  summary: "Breve.", // demasiado corto
  source_url: "not-a-url",
  published_at: "invalid-date",
  organism: "X",
  category: "cat",
  boia_relevance_score: 999, // fuera de rango
  why_it_matters: "Corto.",
};

// ─── JSON Adapter ─────────────────────────────────────────────────────────────

describe("boiaJsonAdapter", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `boia-json-test-${process.pid}-${Date.now()}.json`);
  });

  afterEach(() => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it("debe leer candidatos válidos desde un archivo JSON", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify([VALID_RAW]), "utf-8");

    const { fetchFromJson } = require("../src/ingest/boiaJsonAdapter");
    const candidates = await fetchFromJson(tmpFile);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe(VALID_RAW.id);
    expect(candidates[0].organism).toBe("BCRA");
    expect(candidates[0].boiaRelevanceScore).toBe(85);
  });

  it("debe computar contentHash como string hex de 64 caracteres", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify([VALID_RAW]), "utf-8");

    const { fetchFromJson } = require("../src/ingest/boiaJsonAdapter");
    const [candidate] = await fetchFromJson(tmpFile);

    expect(candidate.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("debe computar ageHours >= 0 para fechas pasadas", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify([VALID_RAW]), "utf-8");

    const { fetchFromJson } = require("../src/ingest/boiaJsonAdapter");
    const [candidate] = await fetchFromJson(tmpFile);

    expect(candidate.ageHours).toBeGreaterThanOrEqual(0);
    expect(candidate.ageHours).toBeLessThan(24);
  });

  it("debe saltear candidatos inválidos y continuar", async () => {
    const mixed = [VALID_RAW, INVALID_RAW];
    fs.writeFileSync(tmpFile, JSON.stringify(mixed), "utf-8");

    const { fetchFromJson } = require("../src/ingest/boiaJsonAdapter");
    const candidates = await fetchFromJson(tmpFile);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe(VALID_RAW.id);
  });

  it("debe deduplicar IDs repetidos dentro del archivo", async () => {
    const duplicated = [VALID_RAW, { ...VALID_RAW }]; // mismo id dos veces
    fs.writeFileSync(tmpFile, JSON.stringify(duplicated), "utf-8");

    const { fetchFromJson } = require("../src/ingest/boiaJsonAdapter");
    const candidates = await fetchFromJson(tmpFile);

    expect(candidates).toHaveLength(1);
  });

  it("debe lanzar error si el archivo no existe", async () => {
    const { fetchFromJson } = require("../src/ingest/boiaJsonAdapter");
    await expect(fetchFromJson("/nonexistent/path/boia.json")).rejects.toThrow(
      /no encontrado/i
    );
  });

  it("debe lanzar error si el JSON no es un array", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ invalid: "object" }), "utf-8");

    const { fetchFromJson } = require("../src/ingest/boiaJsonAdapter");
    await expect(fetchFromJson(tmpFile)).rejects.toThrow(/array/i);
  });

  it("debe normalizar la URL removiendo tracking params", async () => {
    const withTracking = {
      ...VALID_RAW,
      id: "boia-url-test",
      source_url: "https://bcra.gob.ar/test?utm_source=newsletter&utm_medium=email",
    };
    fs.writeFileSync(tmpFile, JSON.stringify([withTracking]), "utf-8");

    const { fetchFromJson } = require("../src/ingest/boiaJsonAdapter");
    const [candidate] = await fetchFromJson(tmpFile);

    expect(candidate.normalizedSourceUrl).not.toContain("utm_");
  });

  it("debe retornar array vacío si el JSON es un array vacío", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify([]), "utf-8");

    const { fetchFromJson } = require("../src/ingest/boiaJsonAdapter");
    const candidates = await fetchFromJson(tmpFile);

    expect(candidates).toHaveLength(0);
  });

  it("debe manejar múltiples candidatos válidos preservando el orden", async () => {
    const second = {
      ...VALID_RAW,
      id: "boia-adapter-002",
      title: "CNV aprueba marco para tokenización de activos financieros del mercado",
      source_url: "https://cnv.gov.ar/test-002",
      organism: "CNV",
    };
    fs.writeFileSync(tmpFile, JSON.stringify([VALID_RAW, second]), "utf-8");

    const { fetchFromJson } = require("../src/ingest/boiaJsonAdapter");
    const candidates = await fetchFromJson(tmpFile);

    expect(candidates).toHaveLength(2);
    expect(candidates[0].id).toBe(VALID_RAW.id);
    expect(candidates[1].id).toBe("boia-adapter-002");
  });
});

// ─── API Adapter ──────────────────────────────────────────────────────────────

describe("boiaApiAdapter", () => {
  beforeEach(() => {
    jest.resetModules();
    // Re-aplicar mocks después de resetModules
    jest.mock("../src/config", () => ({
      config: {
        boiaApiUrl: "http://localhost:9999",
        boiaApiKey: "test-key",
        boiaApiLimit: 50,
        logLevel: "error",
        logDir: "/tmp",
      },
    }));
    jest.mock("../src/config/logger", () => ({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));
  });

  it("debe parsear respuesta en formato array directo", async () => {
    jest.mock("axios", () => ({
      get: jest.fn().mockResolvedValue({ data: [VALID_RAW] }),
      isAxiosError: jest.fn().mockReturnValue(false),
    }));

    const { fetchFromApi } = require("../src/ingest/boiaApiAdapter");
    const candidates = await fetchFromApi();

    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe(VALID_RAW.id);
  });

  it("debe parsear respuesta en formato { items: [...] }", async () => {
    jest.mock("axios", () => ({
      get: jest.fn().mockResolvedValue({ data: { items: [VALID_RAW] } }),
      isAxiosError: jest.fn().mockReturnValue(false),
    }));

    const { fetchFromApi } = require("../src/ingest/boiaApiAdapter");
    const candidates = await fetchFromApi();

    expect(candidates).toHaveLength(1);
    expect(candidates[0].organism).toBe("BCRA");
  });

  it("debe saltear candidatos inválidos del API", async () => {
    jest.mock("axios", () => ({
      get: jest.fn().mockResolvedValue({ data: [VALID_RAW, INVALID_RAW] }),
      isAxiosError: jest.fn().mockReturnValue(false),
    }));

    const { fetchFromApi } = require("../src/ingest/boiaApiAdapter");
    const candidates = await fetchFromApi();

    expect(candidates).toHaveLength(1);
  });

  it("debe lanzar error si BOIA_API_URL no está configurado", async () => {
    jest.mock("../src/config", () => ({
      config: {
        boiaApiUrl: undefined,
        boiaApiKey: "test-key",
        boiaApiLimit: 50,
        logLevel: "error",
        logDir: "/tmp",
      },
    }));

    const { fetchFromApi } = require("../src/ingest/boiaApiAdapter");
    await expect(fetchFromApi()).rejects.toThrow(/BOIA_API_URL/);
  });

  it("debe lanzar error descriptivo en fallo HTTP", async () => {
    const axiosErr = Object.assign(new Error("Request failed"), {
      response: { status: 401, data: { message: "Unauthorized" } },
    });
    jest.mock("axios", () => ({
      get: jest.fn().mockRejectedValue(axiosErr),
      isAxiosError: jest.fn().mockReturnValue(true),
    }));

    const { fetchFromApi } = require("../src/ingest/boiaApiAdapter");
    await expect(fetchFromApi()).rejects.toThrow(/HTTP 401/);
  });

  it("debe lanzar error si la respuesta no es array ni { items: [...] }", async () => {
    jest.mock("axios", () => ({
      get: jest.fn().mockResolvedValue({ data: { unexpected: "shape" } }),
      isAxiosError: jest.fn().mockReturnValue(false),
    }));

    const { fetchFromApi } = require("../src/ingest/boiaApiAdapter");
    await expect(fetchFromApi()).rejects.toThrow(/inesperada/i);
  });
});

// ─── DB Adapter ───────────────────────────────────────────────────────────────

describe("boiaDbAdapter", () => {
  let tmpDb: string;

  beforeEach(() => {
    tmpDb = path.join(os.tmpdir(), `boia-db-test-${process.pid}-${Date.now()}.db`);
  });

  afterEach(() => {
    for (const ext of ["", "-wal", "-shm"]) {
      const f = tmpDb + ext;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  function createBoiaDb(
    rows: Record<string, unknown>[],
    withStatusColumn = false
  ): string {
    const db = new Database(tmpDb);
    const statusCol = withStatusColumn ? ", status TEXT DEFAULT 'ready'" : "";
    db.exec(`
      CREATE TABLE candidates (
        id TEXT PRIMARY KEY,
        title TEXT,
        summary TEXT,
        source_url TEXT,
        published_at TEXT,
        organism TEXT,
        category TEXT,
        tags TEXT,
        boia_relevance_score INTEGER,
        why_it_matters TEXT,
        affected_audience TEXT,
        linkedin_angle TEXT
        ${statusCol}
      )
    `);

    const insert = db.prepare(`
      INSERT INTO candidates
        (id, title, summary, source_url, published_at, organism, category,
         tags, boia_relevance_score, why_it_matters, affected_audience, linkedin_angle
         ${withStatusColumn ? ", status" : ""})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ${withStatusColumn ? ", ?" : ""})
    `);

    for (const row of rows) {
      const vals: unknown[] = [
        row.id, row.title, row.summary, row.source_url, row.published_at,
        row.organism, row.category,
        JSON.stringify(row.tags ?? []),
        row.boia_relevance_score,
        row.why_it_matters,
        JSON.stringify(row.affected_audience ?? []),
        row.linkedin_angle ?? null,
      ];
      if (withStatusColumn) vals.push(row.status ?? "ready");
      insert.run(...vals);
    }

    db.close();
    return tmpDb;
  }

  it("debe leer candidatos válidos desde SQLite", () => {
    createBoiaDb([VALID_RAW]);

    const { fetchFromDb } = require("../src/ingest/boiaDbAdapter");
    const candidates = fetchFromDb(tmpDb, "candidates");

    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe(VALID_RAW.id);
    expect(candidates[0].organism).toBe("BCRA");
  });

  it("debe deserializar campos tags y affected_audience desde JSON string", () => {
    createBoiaDb([VALID_RAW]);

    const { fetchFromDb } = require("../src/ingest/boiaDbAdapter");
    const [candidate] = fetchFromDb(tmpDb, "candidates");

    expect(Array.isArray(candidate.tags)).toBe(true);
    expect(candidate.tags).toContain("psp");
    expect(Array.isArray(candidate.affectedAudience)).toBe(true);
    expect(candidate.affectedAudience).toContain("fintechs");
  });

  it("debe filtrar por status='ready' si la columna existe", () => {
    const readyRow = { ...VALID_RAW, status: "ready" };
    const draftRow = {
      ...VALID_RAW,
      id: "boia-draft-001",
      source_url: "https://bcra.gob.ar/draft",
      status: "draft",
    };
    createBoiaDb([readyRow, draftRow], true);

    const { fetchFromDb } = require("../src/ingest/boiaDbAdapter");
    const candidates = fetchFromDb(tmpDb, "candidates");

    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe(VALID_RAW.id);
  });

  it("debe leer todos los registros si la columna status no existe", () => {
    const second = {
      ...VALID_RAW,
      id: "boia-adapter-002",
      source_url: "https://cnv.gov.ar/test-002",
      title: "CNV aprueba marco para tokenización de activos del mercado capitalino",
      organism: "CNV",
    };
    createBoiaDb([VALID_RAW, second], false); // sin columna status

    const { fetchFromDb } = require("../src/ingest/boiaDbAdapter");
    const candidates = fetchFromDb(tmpDb, "candidates");

    expect(candidates).toHaveLength(2);
  });

  it("debe saltear filas con datos inválidos y continuar", () => {
    const invalidRow = {
      ...VALID_RAW,
      id: "boia-invalid-row",
      title: "Corto", // título muy corto, fallará validación
      source_url: "not-a-url",
      summary: "Breve.", // muy corto
      boia_relevance_score: -999,
    };
    createBoiaDb([VALID_RAW, invalidRow]);

    const { fetchFromDb } = require("../src/ingest/boiaDbAdapter");
    const candidates = fetchFromDb(tmpDb, "candidates");

    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe(VALID_RAW.id);
  });

  it("debe lanzar error si BOIA_DB_PATH no está configurado", () => {
    const { fetchFromDb } = require("../src/ingest/boiaDbAdapter");
    expect(() => fetchFromDb(undefined, "candidates")).toThrow(/BOIA_DB_PATH/);
  });

  it("debe lanzar error si el archivo de DB no existe", () => {
    const { fetchFromDb } = require("../src/ingest/boiaDbAdapter");
    expect(() => fetchFromDb("/nonexistent/boia.db", "candidates")).toThrow(/no encontrada/i);
  });

  it("debe computar contentHash determinista para el mismo candidato", () => {
    createBoiaDb([VALID_RAW]);

    const { fetchFromDb } = require("../src/ingest/boiaDbAdapter");
    const run1 = fetchFromDb(tmpDb, "candidates");
    const run2 = fetchFromDb(tmpDb, "candidates");

    expect(run1[0].contentHash).toBe(run2[0].contentHash);
  });
});
