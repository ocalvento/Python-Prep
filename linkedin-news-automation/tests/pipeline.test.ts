/**
 * Test end-to-end del pipeline BOIA → LinkedIn en dry-run.
 * Verifica que el pipeline completo funciona sin errores
 * y produce resultados coherentes con candidatos BOIA reales.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TEST_DB_PATH = path.join(os.tmpdir(), `test-pipeline-${process.pid}.db`);
const TEST_BOIA_PATH = path.join(os.tmpdir(), `test-pipeline-boia-${process.pid}.json`);

const MOCK_CONFIG = {
  dbPath: TEST_DB_PATH,
  // BOIA source
  boiaSource: "json",
  boiaJsonPath: TEST_BOIA_PATH,
  boiaApiUrl: undefined,
  boiaApiKey: undefined,
  boiaApiLimit: 50,
  boiaDbPath: undefined,
  boiaDbTable: "candidates",
  // Filtros — umbrales bajos para que los ítems de prueba pasen
  boiaMinRelevance: 50,
  linkedinMinScore: 30,
  linkedinSameOrganismMax: 1,
  linkedinExceptionalScore: 90,
  // Config general
  logLevel: "error",
  logDir: "/tmp",
  linkedinClientId: "test",
  linkedinClientSecret: "test",
  linkedinRedirectUri: "http://localhost:3000/callback",
  dryRun: true,
  approvalRequired: false,
  maxPostsPerRun: 5,
  maxNewsAgeDays: 30,
  scorePenaltyMaxPoints: 15,
  maxPostChars: 3000,
  maxHashtags: 4,
  copyMinChars: 100,
  copyPhraseOverlapThreshold: 0.8,
  recentPostsToCheck: 5,
  lockMaxAgeMinutes: 1,
  cronSchedule: "0 9 * * *",
};

jest.mock("../src/config", () => ({ config: MOCK_CONFIG }));
jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Fixture BOIA realista: 3 candidatos (2 por encima del umbral, 1 por debajo)
const BOIA_FIXTURE = [
  {
    id: "boia-test-001",
    title: "BCRA establece nuevos requisitos de liquidez para PSP",
    summary:
      "El Banco Central publicó la Comunicación A 8123 estableciendo que los PSP deberán " +
      "mantener encajes mínimos del 30% sobre el saldo de fondos de clientes. " +
      "La norma entra en vigencia el 1 de julio de 2026 y aplica a todos los PSP autorizados.",
    source_url: "https://bcra.gob.ar/test-001",
    published_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    organism: "BCRA",
    category: "regulacion_financiera",
    tags: ["psp", "liquidez", "regulacion", "fintech"],
    boia_relevance_score: 85,
    why_it_matters:
      "Los 180 PSP habilitados deberán revisar su estructura de capital antes del 1 de julio. " +
      "Para muchos, el 30% de encaje implica inmovilizar capital que hoy rinde en plazos fijos. " +
      "Las fintechs más pequeñas deberán coordinar con sus equipos de tesorería y compliance.",
    affected_audience: ["fintechs", "psp", "compliance", "bancos"],
    linkedin_angle:
      "Las reglas de liquidez para PSP se endurecen: el BCRA exige encajes del 30% desde julio.",
  },
  {
    id: "boia-test-002",
    title: "CNV aprueba marco regulatorio para tokenización de activos financieros",
    summary:
      "La Comisión Nacional de Valores aprobó el primer marco regulatorio para tokenización de " +
      "activos financieros. Habilita a agentes registrados a operar activos tokenizados y establece " +
      "requisitos de custodia. El impacto alcanza a fondos comunes, fideicomisos y ON.",
    source_url: "https://cnv.gov.ar/test-002",
    published_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    organism: "CNV",
    category: "activos_digitales",
    tags: ["tokenizacion", "activos digitales", "regulacion", "cripto"],
    boia_relevance_score: 78,
    why_it_matters:
      "Argentina se convierte en uno de los primeros países de la región con marco para tokenización " +
      "de activos del mercado de capitales. Esto abre la puerta a fondos y fideicomisos on-chain " +
      "con respaldo regulatorio. El impacto es significativo para asset managers y brokers.",
    affected_audience: ["inversores", "legal", "compliance", "fintechs"],
    linkedin_angle:
      "Argentina le da marco legal a la tokenización de activos financieros.",
  },
  {
    id: "boia-test-003",
    title: "Circular informativa sobre estadísticas de mercado sin impacto normativo",
    summary:
      "El BCRA publicó estadísticas trimestrales del mercado interbancario. " +
      "No introduce cambios normativos. Solo referencia para quienes monitorean tasas.",
    source_url: "https://bcra.gob.ar/test-003",
    published_at: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
    organism: "BCRA",
    category: "estadisticas",
    tags: ["tasas", "estadisticas"],
    boia_relevance_score: 28, // por debajo de boiaMinRelevance=50
    why_it_matters:
      "Circular informativa sin cambios normativos. Solo para monitoreo de tasas de referencia.",
    affected_audience: ["tesorería"],
  },
];

beforeAll(() => {
  fs.writeFileSync(TEST_BOIA_PATH, JSON.stringify(BOIA_FIXTURE), "utf-8");
});

afterAll(() => {
  const { closeDb } = require("../src/db");
  closeDb();

  for (const p of [TEST_DB_PATH, TEST_DB_PATH + "-wal", TEST_DB_PATH + "-shm", TEST_BOIA_PATH]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

describe("pipeline — dry-run end-to-end BOIA", () => {
  it("debe completar el pipeline sin lanzar errores", async () => {
    const { runDryRun } = require("../src/jobs/dryRun");
    await expect(runDryRun()).resolves.not.toThrow();
  });

  it("debe procesar todos los candidatos BOIA del archivo", async () => {
    const { closeDb } = require("../src/db");
    closeDb();

    const { runDryRun } = require("../src/jobs/dryRun");
    const result = await runDryRun();
    expect(result.total).toBe(BOIA_FIXTURE.length);
  });

  it("debe saltear el candidato con boia_relevance_score bajo el umbral", async () => {
    const { closeDb } = require("../src/db");
    closeDb();

    const { runDryRun } = require("../src/jobs/dryRun");
    const result = await runDryRun();
    expect(result.skipped_boia_score).toBeGreaterThanOrEqual(1);
  });

  it("debe publicar al menos un candidato que pase ambos filtros", async () => {
    const { closeDb } = require("../src/db");
    closeDb();

    const { runDryRun } = require("../src/jobs/dryRun");
    const result = await runDryRun();
    expect(result.would_publish).toBeGreaterThanOrEqual(1);
  });

  it("no debe publicar más de maxPostsPerRun candidatos", async () => {
    const { closeDb } = require("../src/db");
    closeDb();

    const { runDryRun } = require("../src/jobs/dryRun");
    const result = await runDryRun();
    expect(result.would_publish).toBeLessThanOrEqual(MOCK_CONFIG.maxPostsPerRun);
  });

  it("dry-run no debe escribir en DB (es read-only)", async () => {
    const { closeDb, getDb } = require("../src/db");
    closeDb();

    const dbBefore = getDb();
    const countBefore = (dbBefore.prepare("SELECT COUNT(*) as n FROM posts").get() as { n: number }).n;
    closeDb();

    const { runDryRun } = require("../src/jobs/dryRun");
    await runDryRun();

    const { getDb: getDb2, closeDb: closeDb2 } = require("../src/db");
    const dbAfter = getDb2();
    const countAfter = (dbAfter.prepare("SELECT COUNT(*) as n FROM posts").get() as { n: number }).n;
    expect(countAfter).toBe(countBefore);
    closeDb2();
  });

  it("previews debe contener estructura correcta para ítems publicados", async () => {
    const { closeDb } = require("../src/db");
    closeDb();

    const { runDryRun } = require("../src/jobs/dryRun");
    const result = await runDryRun();

    const published = result.previews.filter((p: { status: string }) => p.status === "would_publish");
    expect(published.length).toBeGreaterThan(0);

    for (const p of published) {
      expect(p).toHaveProperty("id");
      expect(p).toHaveProperty("title");
      expect(p).toHaveProperty("organism");
      expect(p).toHaveProperty("boiaScore");
      expect(p).toHaveProperty("linkedinScore");
      expect(p).toHaveProperty("scoreBreakdown");
      expect(p).toHaveProperty("post");
      if (p.post) {
        expect(p.post).toHaveProperty("text");
        expect(p.post).toHaveProperty("hashtags");
        expect(p.post).toHaveProperty("charCount");
        expect(p.post).toHaveProperty("qualityScore");
      }
    }
  });

  it("previews con skipped deben tener skipReason", async () => {
    const { closeDb } = require("../src/db");
    closeDb();

    const { runDryRun } = require("../src/jobs/dryRun");
    const result = await runDryRun();

    const skipped = result.previews.filter(
      (p: { status: string }) => p.status !== "would_publish" && p.status !== "skipped_limit"
    );
    for (const p of skipped) {
      expect(p.skipReason).toBeDefined();
      expect(typeof p.skipReason).toBe("string");
    }
  });
});
