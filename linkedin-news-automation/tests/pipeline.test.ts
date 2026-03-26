/**
 * Test end-to-end del pipeline en dry-run.
 * Verifica que el pipeline completo funciona sin errores
 * y produce resultados coherentes.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TEST_DB_PATH = path.join(os.tmpdir(), `test-pipeline-${process.pid}.db`);
const TEST_NEWS_PATH = path.join(os.tmpdir(), `test-pipeline-news-${process.pid}.json`);

const MOCK_CONFIG = {
  dbPath: TEST_DB_PATH,
  newsInputPath: TEST_NEWS_PATH,
  logLevel: "error",
  logDir: "/tmp",
  linkedinClientId: "test",
  linkedinClientSecret: "test",
  linkedinRedirectUri: "http://localhost:3000/callback",
  scoreThreshold: 50, // umbral bajo para que los ítems de prueba pasen
  dryRun: true,
  approvalRequired: false,
  maxPostsPerRun: 5,
  maxNewsAgeDays: 30,
  scoreWeightRecency: 30,
  scoreWeightTags: 30,
  scoreWeightSource: 20,
  scoreWeightLength: 10,
  scoreWeightBonus: 5,
  scorePenaltyMaxPoints: 15,
  maxPostChars: 3000,
  maxHashtags: 4,
  copyMinChars: 100, // más permisivo para tests
  copyPhraseOverlapThreshold: 0.8, // más permisivo para tests
  recentPostsToCheck: 5,
  lockMaxAgeMinutes: 1,
  cronSchedule: "0 9 * * *",
};

jest.mock("../src/config", () => ({ config: MOCK_CONFIG }));
jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const NEWS_FIXTURE = [
  {
    title: "OpenAI lanza nuevo modelo con capacidades avanzadas de razonamiento",
    summary:
      "OpenAI presentó su nuevo modelo de lenguaje más avanzado. Según la empresa, " +
      "supera a su predecesor en un 40% en benchmarks de razonamiento. " +
      "El modelo reduce las alucinaciones en un 60% y ya está disponible para desarrolladores.",
    url: "https://techcrunch.com/2026/03/openai-new-model",
    source: "TechCrunch",
    published_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    tags: ["ia", "machine learning", "tecnología"],
  },
  {
    title: "Estudio de Harvard revela claves del liderazgo efectivo en equipos remotos",
    summary:
      "Una investigación de Harvard Business Review analizó 800 equipos distribuidos y encontró " +
      "que el 73% de los equipos de alto rendimiento priorizan la autonomía sobre el control. " +
      "Los líderes más efectivos dan contexto claro y delegan responsabilidad real.",
    url: "https://hbr.org/2026/03/remote-leadership",
    source: "Harvard Business Review",
    published_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    tags: ["liderazgo", "management", "talento"],
  },
  {
    title: "Tips para mejorar tu rutina de mañana",
    summary: "Algunos consejos generales para el día a día sin mucho contenido específico.",
    url: "https://blog.example.com/tips-rutina",
    source: "Blog personal",
    published_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    tags: ["lifestyle"],
  },
];

beforeAll(() => {
  fs.writeFileSync(TEST_NEWS_PATH, JSON.stringify(NEWS_FIXTURE), "utf-8");
});

afterAll(() => {
  const { closeDb } = require("../src/db");
  closeDb();

  for (const p of [TEST_DB_PATH, TEST_DB_PATH + "-wal", TEST_DB_PATH + "-shm", TEST_NEWS_PATH]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

describe("pipeline — dry-run end-to-end", () => {
  it("debe completar el pipeline sin lanzar errores", async () => {
    const { runDryRun } = require("../src/jobs/dryRun");
    await expect(runDryRun()).resolves.not.toThrow();
  });

  it("debe procesar todos los ítems del archivo", async () => {
    const { closeDb } = require("../src/db");
    closeDb();

    const { runDryRun } = require("../src/jobs/dryRun");
    const result = await runDryRun();
    expect(result.total).toBe(NEWS_FIXTURE.length);
  });

  it("debe publicar al menos uno y saltear el lifestyle", async () => {
    const { closeDb } = require("../src/db");
    closeDb();

    const { runDryRun } = require("../src/jobs/dryRun");
    const result = await runDryRun();

    // Los dos primeros tienen tags relevantes y deben pasar el umbral
    expect(result.would_publish).toBeGreaterThanOrEqual(1);
    // El ítem de lifestyle debería ser saltado por score bajo
    expect(result.skipped_threshold + result.skipped_copy_quality).toBeGreaterThanOrEqual(1);
  });

  it("no debe publicar más de maxPostsPerRun ítems", async () => {
    const { closeDb } = require("../src/db");
    closeDb();

    const { runDryRun } = require("../src/jobs/dryRun");
    const result = await runDryRun();
    expect(result.would_publish).toBeLessThanOrEqual(MOCK_CONFIG.maxPostsPerRun);
  });

  it("dry-run no debe escribir en DB (es read-only)", async () => {
    const { closeDb, getDb } = require("../src/db");
    closeDb();

    // Contar registros antes
    const dbBefore = getDb();
    const countBefore = (dbBefore.prepare("SELECT COUNT(*) as n FROM posts").get() as { n: number }).n;
    closeDb();

    const { runDryRun } = require("../src/jobs/dryRun");
    await runDryRun();

    // La DB no debe tener más registros después del dry-run
    const { getDb: getDb2, closeDb: closeDb2 } = require("../src/db");
    const dbAfter = getDb2();
    const countAfter = (dbAfter.prepare("SELECT COUNT(*) as n FROM posts").get() as { n: number }).n;
    expect(countAfter).toBe(countBefore);
    closeDb2();
  });

  it("previews debe contener la estructura correcta para ítems publicados", async () => {
    const { closeDb } = require("../src/db");
    closeDb();

    // Nueva DB para este test
    const freshDbPath = TEST_DB_PATH + ".fresh";
    MOCK_CONFIG.dbPath = freshDbPath;

    const { runDryRun } = require("../src/jobs/dryRun");
    const result = await runDryRun();

    const published = result.previews.filter((p: { status: string }) => p.status === "would_publish");
    for (const p of published) {
      expect(p).toHaveProperty("title");
      expect(p).toHaveProperty("score");
      expect(p).toHaveProperty("scoreBreakdown");
      expect(p).toHaveProperty("post");
      if (p.post) {
        expect(p.post).toHaveProperty("text");
        expect(p.post).toHaveProperty("hashtags");
        expect(p.post).toHaveProperty("charCount");
        expect(p.post).toHaveProperty("qualityScore");
      }
    }

    closeDb();
    for (const ext of ["", "-wal", "-shm"]) {
      if (fs.existsSync(freshDbPath + ext)) fs.unlinkSync(freshDbPath + ext);
    }
    MOCK_CONFIG.dbPath = TEST_DB_PATH;
  });
});
