import { scoreItem, scoreItems } from "../src/scoring/scorer";
import { IngestedNewsItem } from "../src/ingest/newsReader";

// Mock de config para tests
jest.mock("../src/config", () => ({
  config: {
    scoreThreshold: 75,
    dryRun: false,
    logLevel: "error",
    logDir: "/tmp",
    newsInputPath: "./inputs/news.json",
    dbPath: "/tmp/test.db",
    cronSchedule: "0 9 * * *",
    linkedinClientId: "test",
    linkedinClientSecret: "test",
    linkedinRedirectUri: "http://localhost:3000/callback",
  },
}));

jest.mock("../src/config/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

function makeItem(overrides: Partial<IngestedNewsItem> = {}): IngestedNewsItem {
  return {
    title: "Artículo de prueba sobre inteligencia artificial",
    summary: "Este es un resumen de prueba con suficiente contenido para ser válido. Contiene información sobre el impacto de la IA en la industria y cómo las empresas están adoptando estas tecnologías.",
    url: "https://example.com/test-article",
    source: "TechCrunch",
    published_at: new Date().toISOString(),
    tags: ["ia", "tecnología"],
    contentHash: "abc123",
    ageHours: 2,
    ...overrides,
  };
}

describe("scorer", () => {
  describe("scoreItem", () => {
    it("debe asignar score alto a noticia reciente con tags relevantes", () => {
      const item = makeItem({
        ageHours: 1,
        tags: ["ia", "innovación", "tecnología"],
        source: "TechCrunch",
      });
      const result = scoreItem(item);
      expect(result.score).toBeGreaterThanOrEqual(75);
    });

    it("debe asignar score bajo a noticia antigua", () => {
      const item = makeItem({
        ageHours: 200, // ~8 días
        tags: ["lifestyle"],
        source: "Blog desconocido",
        summary: "Texto corto.",
      });
      const result = scoreItem(item);
      expect(result.score).toBeLessThan(50);
    });

    it("debe dar bonus por datos numéricos con porcentajes", () => {
      const withData = makeItem({
        summary: "Según el estudio, el 73% de las empresas adoptaron IA en 2025.",
      });
      const withoutData = makeItem({
        summary: "Muchas empresas adoptaron tecnología en los últimos años.",
      });
      const scoreWith = scoreItem(withData).score;
      const scoreWithout = scoreItem(withoutData).score;
      expect(scoreWith).toBeGreaterThan(scoreWithout);
    });

    it("no debe superar 100", () => {
      const item = makeItem({
        ageHours: 0,
        tags: ["ia", "machine learning", "innovación", "startup", "tecnología"],
        source: "Harvard Business Review",
        summary: "Según el informe, el 99% de las empresas con $10 millones USD en inversión lograron resultados sobresalientes. Este estudio de Harvard analiza en profundidad los factores determinantes del éxito empresarial en el contexto tecnológico actual.",
      });
      const result = scoreItem(item);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it("debe incluir scoreBreakdown con todos los campos", () => {
      const result = scoreItem(makeItem());
      expect(result.scoreBreakdown).toHaveProperty("recency");
      expect(result.scoreBreakdown).toHaveProperty("tagRelevance");
      expect(result.scoreBreakdown).toHaveProperty("sourceCredibility");
      expect(result.scoreBreakdown).toHaveProperty("contentLength");
      expect(result.scoreBreakdown).toHaveProperty("bonus");
    });

    it("debe dar 20 puntos de credibilidad a fuentes confiables", () => {
      const trusted = makeItem({ source: "Harvard Business Review" });
      const unknown = makeItem({ source: "Blog cualquiera" });
      const scoreTrusted = scoreItem(trusted).scoreBreakdown.sourceCredibility;
      const scoreUnknown = scoreItem(unknown).scoreBreakdown.sourceCredibility;
      expect(scoreTrusted).toBe(20);
      expect(scoreUnknown).toBe(5);
    });
  });

  describe("scoreItems", () => {
    it("debe ordenar por score descendente", () => {
      const items = [
        makeItem({ ageHours: 100, tags: ["lifestyle"] }),
        makeItem({ ageHours: 1, tags: ["ia", "innovación"], source: "TechCrunch" }),
        makeItem({ ageHours: 48, tags: ["negocios"] }),
      ];
      const scored = scoreItems(items);
      expect(scored[0].score).toBeGreaterThanOrEqual(scored[1].score);
      expect(scored[1].score).toBeGreaterThanOrEqual(scored[2].score);
    });
  });
});
