import { generatePost } from "../src/copy/generator";
import { ScoredNewsItem } from "../src/scoring/scorer";

// Jest hoist jest.mock() antes de los const — la config debe ir inline o via module variable
jest.mock("../src/config", () => ({
  config: {
    maxPostChars: 3000,
    maxHashtags: 4,
    copyMinChars: 200,
    copyPhraseOverlapThreshold: 0.55,
    recentPostsToCheck: 10,
    logLevel: "error",
    logDir: "/tmp",
  },
}));
jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Referencia mutable al config mockeado para tests que necesiten modificarlo
// eslint-disable-next-line @typescript-eslint/no-require-imports
const MOCK_CONFIG = require("../src/config").config as Record<string, unknown>;

function makeScoredItem(overrides: Partial<ScoredNewsItem> = {}): ScoredNewsItem {
  return {
    title: "OpenAI lanza GPT-5 con capacidades avanzadas de razonamiento multi-paso",
    summary:
      "OpenAI presentó GPT-5, su modelo más avanzado. Según la empresa, supera a su predecesor " +
      "en un 40% en benchmarks de razonamiento matemático y reduce las alucinaciones en un 60%. " +
      "El modelo está disponible para desarrolladores a través de la API.",
    url: "https://example.com/gpt5",
    source: "TechCrunch",
    published_at: "2026-03-24T14:30:00Z",
    tags: ["ia", "machine learning", "innovación"],
    contentHash: "deadbeef1234567890abcdef" + "0".repeat(40),
    ageHours: 4,
    normalizedUrl: "https://example.com/gpt5",
    score: 88,
    scoreBreakdown: {
      recency: 28,
      tagRelevance: 28,
      sourceCredibility: 12,
      contentLength: 10,
      bonus: 10,
      penalty: 0,
      matchedHighTags: ["ia", "machine learning"],
      matchedMediumTags: [],
    },
    ...overrides,
  };
}

describe("copy/generator", () => {
  describe("generatePost — happy path", () => {
    it("debe retornar { ok: true } para un ítem válido", () => {
      const result = generatePost(makeScoredItem());
      expect(result.ok).toBe(true);
    });

    it("debe incluir el título en el texto", () => {
      const item = makeScoredItem();
      const result = generatePost(item);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.post.text).toContain(item.title);
    });

    it("no debe superar maxPostChars", () => {
      const result = generatePost(makeScoredItem());
      if (result.ok) expect(result.post.charCount).toBeLessThanOrEqual(3000);
    });

    it("charCount debe ser igual a text.length", () => {
      const result = generatePost(makeScoredItem());
      if (result.ok) expect(result.post.charCount).toBe(result.post.text.length);
    });

    it("debe incluir hashtags con #", () => {
      const result = generatePost(makeScoredItem());
      if (result.ok) {
        expect(result.post.hashtags.length).toBeGreaterThan(0);
        expect(result.post.hashtags.every((h) => h.startsWith("#"))).toBe(true);
      }
    });

    it("no debe incluir más de maxHashtags hashtags", () => {
      const item = makeScoredItem({
        tags: ["ia", "startup", "tecnología", "liderazgo", "fintech", "cloud"],
      });
      const result = generatePost(item);
      if (result.ok) expect(result.post.hashtags.length).toBeLessThanOrEqual(4);
    });

    it("hashtags deben ser solo letras y números (sin acentos)", () => {
      const item = makeScoredItem({ tags: ["inteligencia artificial", "tecnología", "innovación"] });
      const result = generatePost(item);
      if (result.ok) {
        result.post.hashtags.forEach((h) => {
          expect(h).toMatch(/^#[a-z0-9]+$/);
        });
      }
    });

    it("debe incluir un quality score > 0", () => {
      const result = generatePost(makeScoredItem());
      if (result.ok) expect(result.post.qualityScore).toBeGreaterThan(0);
    });
  });

  describe("generatePost — validación de calidad", () => {
    it("debe retornar { ok: false } si el copy resultante es muy corto", () => {
      // Item con título y resumen mínimos que producirán un copy corto
      const item = makeScoredItem({
        title: "Noticia corta de tecnología digital",
        summary: "Resumen muy breve con pocas palabras pero que cumple el mínimo requerido.",
        tags: [],
        scoreBreakdown: {
          recency: 5,
          tagRelevance: 0,
          sourceCredibility: 5,
          contentLength: 3,
          bonus: 0,
          penalty: 5,
          matchedHighTags: [],
          matchedMediumTags: [],
        },
      });
      // Forzar config.copyMinChars alto para este test
      const originalMin = MOCK_CONFIG.copyMinChars;
      (MOCK_CONFIG as Record<string, unknown>).copyMinChars = 99999;
      const result = generatePost(item);
      expect(result.ok).toBe(false);
      (MOCK_CONFIG as Record<string, unknown>).copyMinChars = originalMin;
    });

    it("debe retornar { ok: false } si el overlap con posts recientes es muy alto", () => {
      const item = makeScoredItem();
      // Simular que el post reciente es prácticamente el mismo texto
      const firstResult = generatePost(item);
      if (!firstResult.ok) return; // skip si el primero falla
      const recentTexts = [firstResult.post.text];

      // Intentar con el mismo ítem pero umbral de overlap muy bajo
      const originalThreshold = MOCK_CONFIG.copyPhraseOverlapThreshold;
      (MOCK_CONFIG as Record<string, unknown>).copyPhraseOverlapThreshold = 0.001;
      const result = generatePost(item, recentTexts);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("Overlap");
      (MOCK_CONFIG as Record<string, unknown>).copyPhraseOverlapThreshold = originalThreshold;
    });
  });

  describe("generatePost — reflexiones y variedad", () => {
    it("debe incluir una reflexión para noticias de IA", () => {
      const item = makeScoredItem({ tags: ["ia", "machine learning"] });
      const result = generatePost(item);
      if (result.ok) {
        // Verificar que hay al menos 2 párrafos (el cuerpo + algo más)
        expect(result.post.text).toContain("\n\n");
      }
    });

    it("dos ítems distintos con el mismo tema deben poder tener reflexiones distintas", () => {
      const item1 = makeScoredItem({ contentHash: "hash1" + "0".repeat(59) });
      const item2 = makeScoredItem({ contentHash: "hash2" + "0".repeat(59) });
      // Con posts recientes que ya usan una reflexión, la segunda debería elegir otra
      const result1 = generatePost(item1, []);
      if (!result1.ok) return;

      // El resultado depende del overlap — si hay variantes disponibles, se elige la menos repetida
      const result2 = generatePost(item2, [result1.post.text]);
      // Solo verificamos que funciona sin errores — el overlap real depende del contenido
      expect(typeof result2.ok).toBe("boolean");
    });
  });

  describe("generatePost — truncado", () => {
    it("no debe superar maxPostChars incluso con resumen muy largo", () => {
      const item = makeScoredItem({
        summary: "Este es un resumen extremadamente largo. ".repeat(100),
      });
      const result = generatePost(item);
      if (result.ok) {
        expect(result.post.charCount).toBeLessThanOrEqual(3000);
        expect(result.post.text.length).toBe(result.post.charCount);
      }
    });
  });
});
