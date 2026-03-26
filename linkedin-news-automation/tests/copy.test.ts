import { generatePost } from "../src/copy/generator";
import { ScoredBoiaCandidate } from "../src/scoring/editorialScorer";

jest.mock("../src/config", () => ({
  config: {
    maxPostChars: 3000,
    maxHashtags: 4,
    copyMinChars: 200,
    copyPhraseOverlapThreshold: 0.55,
    recentPostsToCheck: 10,
    scorePenaltyMaxPoints: 15,
    logLevel: "error",
    logDir: "/tmp",
  },
}));
jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const MOCK_CONFIG = require("../src/config").config as Record<string, unknown>;

function makeScoredCandidate(overrides: Partial<ScoredBoiaCandidate> = {}): ScoredBoiaCandidate {
  return {
    id: "boia-test-001",
    title: "BCRA establece nuevos requisitos de liquidez para PSP",
    summary:
      "El Banco Central publicó la Comunicación A 8123 estableciendo que los PSP deberán " +
      "mantener encajes mínimos del 30% sobre el saldo de fondos de clientes. " +
      "La norma entra en vigencia el 1 de julio de 2026 y aplica a todos los PSP autorizados.",
    sourceUrl: "https://bcra.gob.ar/test",
    publishedAt: new Date().toISOString(),
    organism: "BCRA",
    category: "regulacion_financiera",
    tags: ["psp", "liquidez", "regulacion", "fintech"],
    boiaRelevanceScore: 85,
    whyItMatters:
      "Los 180 PSP habilitados deberán revisar su estructura de capital antes del 1 de julio. " +
      "Para muchos, el 30% de encaje implica inmovilizar capital. Las fintechs deberán " +
      "adaptar su modelo operativo con impacto directo en la tesorería.",
    affectedAudience: ["fintechs", "psp", "compliance", "bancos"],
    linkedinAngle:
      "Las reglas de liquidez para PSP se endurecen: el BCRA exige encajes del 30% desde julio.",
    contentHash: "a".repeat(64),
    ageHours: 6,
    normalizedSourceUrl: "https://bcra.gob.ar/test",
    linkedinPublishScore: 82,
    scoreBreakdown: {
      organismRelevance: 25,
      audienceImpact: 22,
      messageClarity: 12,
      recency: 13,
      conversationPotential: 9,
      dataBonus: 8,
      technicalityPenalty: 0,
      matchedAudience: ["fintechs", "psp", "compliance", "bancos"],
    },
    ...overrides,
  };
}

describe("copy/generator", () => {
  describe("generatePost — happy path", () => {
    it("debe retornar { ok: true } para un candidato BOIA válido", () => {
      const result = generatePost(makeScoredCandidate());
      expect(result.ok).toBe(true);
    });

    it("debe incluir el título en el texto", () => {
      const candidate = makeScoredCandidate();
      const result = generatePost(candidate);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.post.text).toContain(candidate.title);
    });

    it("no debe superar maxPostChars", () => {
      const result = generatePost(makeScoredCandidate());
      if (result.ok) expect(result.post.charCount).toBeLessThanOrEqual(3000);
    });

    it("charCount debe ser igual a text.length", () => {
      const result = generatePost(makeScoredCandidate());
      if (result.ok) expect(result.post.charCount).toBe(result.post.text.length);
    });

    it("debe incluir hashtags con #", () => {
      const result = generatePost(makeScoredCandidate());
      if (result.ok) {
        expect(result.post.hashtags.length).toBeGreaterThan(0);
        expect(result.post.hashtags.every((h) => h.startsWith("#"))).toBe(true);
      }
    });

    it("no debe incluir más de maxHashtags hashtags", () => {
      const candidate = makeScoredCandidate({
        tags: ["psp", "liquidez", "regulacion", "fintech", "bancos", "crypto"],
      });
      const result = generatePost(candidate);
      if (result.ok) expect(result.post.hashtags.length).toBeLessThanOrEqual(4);
    });

    it("hashtags deben ser solo letras y números (sin acentos)", () => {
      const candidate = makeScoredCandidate({
        tags: ["regulación", "protección", "tecnología"],
      });
      const result = generatePost(candidate);
      if (result.ok) {
        result.post.hashtags.forEach((h) => {
          expect(h).toMatch(/^#[a-z0-9]+$/);
        });
      }
    });

    it("debe incluir un quality score > 0", () => {
      const result = generatePost(makeScoredCandidate());
      if (result.ok) expect(result.post.qualityScore).toBeGreaterThan(0);
    });
  });

  describe("generatePost — validación de calidad", () => {
    it("debe retornar { ok: false } si el copy resultante es muy corto", () => {
      const originalMin = MOCK_CONFIG.copyMinChars;
      MOCK_CONFIG.copyMinChars = 99999;
      const result = generatePost(makeScoredCandidate());
      expect(result.ok).toBe(false);
      MOCK_CONFIG.copyMinChars = originalMin;
    });

    it("debe retornar { ok: false } si el overlap con posts recientes es muy alto", () => {
      const candidate = makeScoredCandidate();
      const firstResult = generatePost(candidate);
      if (!firstResult.ok) return;
      const recentTexts = [firstResult.post.text];

      const originalThreshold = MOCK_CONFIG.copyPhraseOverlapThreshold;
      MOCK_CONFIG.copyPhraseOverlapThreshold = 0.001;
      const result = generatePost(candidate, recentTexts);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("Overlap");
      MOCK_CONFIG.copyPhraseOverlapThreshold = originalThreshold;
    });
  });

  describe("generatePost — contenido regulatorio", () => {
    it("debe mencionar el organismo en el texto", () => {
      const candidate = makeScoredCandidate({ linkedinAngle: undefined });
      const result = generatePost(candidate);
      if (result.ok) {
        expect(result.post.text.toLowerCase()).toContain("bcra");
      }
    });

    it("debe incluir estructura de párrafos (hook + cuerpo + CTA)", () => {
      const result = generatePost(makeScoredCandidate());
      if (result.ok) {
        expect(result.post.text).toContain("\n\n");
      }
    });

    it("linkedinAngle provisto debe usarse como base del cuerpo", () => {
      const withAngle = makeScoredCandidate({
        linkedinAngle: "Texto editorial exclusivo para PSP que cambia el modelo operativo.",
      });
      const withoutAngle = makeScoredCandidate({ linkedinAngle: undefined });
      const r1 = generatePost(withAngle);
      const r2 = generatePost(withoutAngle);
      // Ambos deberían pasar, pero el body debe ser distinto
      if (r1.ok && r2.ok) {
        expect(r1.post.text).not.toBe(r2.post.text);
      }
    });

    it("no debe copiar el summary verbatim", () => {
      const candidate = makeScoredCandidate();
      const result = generatePost(candidate);
      if (result.ok) {
        const summaryStart = candidate.summary.substring(0, 50).toLowerCase();
        expect(result.post.text.toLowerCase()).not.toContain(summaryStart);
      }
    });
  });

  describe("generatePost — truncado", () => {
    it("no debe superar maxPostChars incluso con whyItMatters muy largo", () => {
      const candidate = makeScoredCandidate({
        whyItMatters: "Esta norma impacta directamente en los procesos operativos. ".repeat(50),
      });
      const result = generatePost(candidate);
      if (result.ok) {
        expect(result.post.charCount).toBeLessThanOrEqual(3000);
        expect(result.post.text.length).toBe(result.post.charCount);
      }
    });
  });
});
