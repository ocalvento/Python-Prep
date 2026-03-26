import { scoreItem, scoreItems } from "../src/scoring/scorer";
import { IngestedNewsItem } from "../src/ingest/newsReader";

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
    scoreWeightRecency: 30,
    scoreWeightTags: 30,
    scoreWeightSource: 20,
    scoreWeightLength: 10,
    scoreWeightBonus: 5,
    scorePenaltyMaxPoints: 15,
    maxPostsPerRun: 3,
    maxNewsAgeDays: 30,
    approvalRequired: false,
    maxPostChars: 3000,
    maxHashtags: 4,
    copyMinChars: 200,
    copyPhraseOverlapThreshold: 0.55,
    recentPostsToCheck: 10,
    lockMaxAgeMinutes: 30,
  },
}));

jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function makeItem(overrides: Partial<IngestedNewsItem> = {}): IngestedNewsItem {
  return {
    title: "OpenAI lanza GPT-5 con capacidades avanzadas de razonamiento",
    summary:
      "Este es un resumen suficientemente largo con información valiosa sobre inteligencia artificial. " +
      "Según el informe, el 40% de las empresas ya adoptaron herramientas de IA. " +
      "El impacto en la productividad es significativo y medible.",
    url: "https://example.com/test-article",
    source: "TechCrunch",
    published_at: new Date().toISOString(),
    tags: ["ia", "tecnología"],
    contentHash: "deadbeef" + "0".repeat(56),
    ageHours: 2,
    normalizedUrl: "https://example.com/test-article",
    ...overrides,
  };
}

describe("scorer", () => {
  describe("scoreItem — puntajes base", () => {
    it("debe asignar score alto a noticia reciente con tags de alto valor", () => {
      const item = makeItem({
        ageHours: 1,
        tags: ["ia", "innovación", "tecnología"],
        source: "TechCrunch",
      });
      expect(scoreItem(item).score).toBeGreaterThanOrEqual(65);
    });

    it("debe asignar score bajo a noticia antigua con tags irrelevantes", () => {
      const item = makeItem({
        ageHours: 300,
        tags: ["lifestyle"],
        source: "Blog desconocido",
        summary: "Breve texto sin datos.",
        title: "Tips",
      });
      expect(scoreItem(item).score).toBeLessThan(35);
    });

    it("no debe superar 100", () => {
      const item = makeItem({
        ageHours: 0,
        tags: ["ia", "machine learning", "innovación", "startup", "tecnología", "fintech"],
        source: "Harvard Business Review",
        summary:
          "Según el informe, el 99% de las empresas con $10 millones USD lograron resultados. ".repeat(3),
      });
      expect(scoreItem(item).score).toBeLessThanOrEqual(100);
    });

    it("debe incluir todos los campos en scoreBreakdown", () => {
      const result = scoreItem(makeItem());
      expect(result.scoreBreakdown).toMatchObject({
        recency: expect.any(Number),
        tagRelevance: expect.any(Number),
        sourceCredibility: expect.any(Number),
        contentLength: expect.any(Number),
        bonus: expect.any(Number),
        penalty: expect.any(Number),
        matchedHighTags: expect.any(Array),
        matchedMediumTags: expect.any(Array),
      });
    });

    it("debe reportar los tags de alto valor que coinciden", () => {
      const item = makeItem({ tags: ["ia", "startup", "lifestyle"] });
      const result = scoreItem(item);
      expect(result.scoreBreakdown.matchedHighTags).toContain("ia");
      expect(result.scoreBreakdown.matchedHighTags).toContain("startup");
      expect(result.scoreBreakdown.matchedHighTags).not.toContain("lifestyle");
    });
  });

  describe("scoreItem — fuentes", () => {
    it("debe dar puntaje máximo de fuente a fuentes conocidas", () => {
      const trusted = makeItem({ source: "Harvard Business Review" });
      const unknown = makeItem({ source: "Blog cualquiera" });
      expect(scoreItem(trusted).scoreBreakdown.sourceCredibility).toBeGreaterThan(
        scoreItem(unknown).scoreBreakdown.sourceCredibility
      );
    });

    it("debe dar puntaje parcial a fuentes con coincidencia parcial", () => {
      const partial = makeItem({ source: "MIT Technology Review — Español" });
      const credScore = scoreItem(partial).scoreBreakdown.sourceCredibility;
      expect(credScore).toBeGreaterThan(5);
      expect(credScore).toBeLessThan(20);
    });
  });

  describe("scoreItem — recencia", () => {
    it("noticia de 1h debe tener más recency que una de 48h", () => {
      const recent = scoreItem(makeItem({ ageHours: 1 }));
      const old = scoreItem(makeItem({ ageHours: 48 }));
      expect(recent.scoreBreakdown.recency).toBeGreaterThan(old.scoreBreakdown.recency);
    });

    it("ageHours negativo debe dar recency 0", () => {
      const item = makeItem({ ageHours: -5 });
      expect(scoreItem(item).scoreBreakdown.recency).toBe(0);
    });
  });

  describe("scoreItem — bonus y penalidades", () => {
    it("debe dar bonus por datos con porcentajes", () => {
      const withPct = makeItem({ summary: "Según el estudio, el 73% de las empresas adoptaron IA en 2025 con buenos resultados." });
      const withoutPct = makeItem({ summary: "Muchas empresas adoptaron tecnología en los últimos años con buenos resultados reportados." });
      expect(scoreItem(withPct).scoreBreakdown.bonus).toBeGreaterThan(
        scoreItem(withoutPct).scoreBreakdown.bonus
      );
    });

    it("debe penalizar frases genéricas", () => {
      const generic = makeItem({
        title: "En el mundo actual la tecnología es fundamental",
        summary: "En el mundo de hoy es más importante que nunca adaptarse. Sin lugar a dudas el futuro es digital y cada vez más importante.",
      });
      expect(scoreItem(generic).scoreBreakdown.penalty).toBeGreaterThan(0);
    });

    it("debe penalizar resumen muy corto", () => {
      const shortSummary = makeItem({ summary: "Texto muy corto sin mucho contenido." });
      const longSummary = makeItem({
        summary: "Este resumen tiene suficientes palabras para no ser penalizado porque contiene información sustancial y relevante sobre el tema tratado, incluyendo datos y contexto.",
      });
      expect(scoreItem(shortSummary).scoreBreakdown.penalty).toBeGreaterThan(
        scoreItem(longSummary).scoreBreakdown.penalty
      );
    });

    it("debe penalizar si no hay tags relevantes", () => {
      const noRelevant = makeItem({ tags: ["lifestyle", "recetas", "moda"] });
      expect(scoreItem(noRelevant).scoreBreakdown.penalty).toBeGreaterThan(3);
    });

    it("score nunca debe ser negativo", () => {
      const worst = makeItem({
        ageHours: 700,
        tags: ["lifestyle"],
        source: "Blog anónimo",
        summary: "Tips para mejorar. En el mundo actual es más importante que nunca.",
        title: "Tips",
      });
      expect(scoreItem(worst).score).toBeGreaterThanOrEqual(0);
    });
  });

  describe("scoreItems — ordenamiento", () => {
    it("debe ordenar por score descendente", () => {
      const items = [
        makeItem({ ageHours: 200, tags: ["lifestyle"] }),
        makeItem({ ageHours: 1, tags: ["ia", "innovación"], source: "TechCrunch" }),
        makeItem({ ageHours: 48, tags: ["negocios"] }),
      ];
      const scored = scoreItems(items);
      for (let i = 0; i < scored.length - 1; i++) {
        expect(scored[i].score).toBeGreaterThanOrEqual(scored[i + 1].score);
      }
    });
  });

  describe("scoreItem — retornos decrecientes en tags", () => {
    it("muchos tags de alto valor no deben sumar más del máximo configurado", () => {
      const manyHighTags = makeItem({
        tags: ["ia", "machine learning", "startup", "fintech", "cloud", "data", "liderazgo"],
      });
      const result = scoreItem(manyHighTags);
      expect(result.scoreBreakdown.tagRelevance).toBeLessThanOrEqual(30); // scoreWeightTags
    });
  });
});
