import { generatePost } from "../src/copy/generator";
import { ScoredNewsItem } from "../src/scoring/scorer";

jest.mock("../src/config/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

function makeScoredItem(overrides: Partial<ScoredNewsItem> = {}): ScoredNewsItem {
  return {
    title: "OpenAI lanza GPT-5 con capacidades avanzadas de razonamiento",
    summary: "OpenAI presentó GPT-5, su modelo más avanzado. Según la empresa, supera a su predecesor en un 40% en benchmarks de razonamiento matemático y reduce las alucinaciones en un 60%. El modelo está disponible para desarrolladores.",
    url: "https://example.com/gpt5",
    source: "TechCrunch",
    published_at: "2026-03-24T14:30:00Z",
    tags: ["ia", "machine learning", "innovación"],
    contentHash: "deadbeef1234567890abcdef",
    ageHours: 4,
    score: 88,
    scoreBreakdown: {
      recency: 28,
      tagRelevance: 30,
      sourceCredibility: 12,
      contentLength: 10,
      bonus: 8,
    },
    ...overrides,
  };
}

describe("copy/generator", () => {
  describe("generatePost", () => {
    it("debe generar texto no vacío", () => {
      const result = generatePost(makeScoredItem());
      expect(result.text.length).toBeGreaterThan(50);
    });

    it("no debe superar 3000 caracteres", () => {
      const result = generatePost(makeScoredItem());
      expect(result.charCount).toBeLessThanOrEqual(3000);
    });

    it("debe incluir hashtags", () => {
      const result = generatePost(makeScoredItem());
      expect(result.hashtags.length).toBeGreaterThan(0);
      expect(result.hashtags.every((h) => h.startsWith("#"))).toBe(true);
    });

    it("no debe incluir más de 4 hashtags", () => {
      const item = makeScoredItem({
        tags: ["ia", "startup", "tecnología", "liderazgo", "fintech", "cloud"],
      });
      const result = generatePost(item);
      expect(result.hashtags.length).toBeLessThanOrEqual(4);
    });

    it("debe incluir el título en el texto", () => {
      const item = makeScoredItem();
      const result = generatePost(item);
      expect(result.text).toContain(item.title);
    });

    it("debe generar hashtags sin caracteres especiales", () => {
      const item = makeScoredItem({ tags: ["inteligencia artificial", "tecnología", "innovación"] });
      const result = generatePost(item);
      result.hashtags.forEach((h) => {
        expect(h).toMatch(/^#[a-z0-9]+$/);
      });
    });

    it("charCount debe coincidir con la longitud del texto", () => {
      const result = generatePost(makeScoredItem());
      expect(result.charCount).toBe(result.text.length);
    });
  });
});
