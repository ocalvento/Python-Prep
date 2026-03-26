import { scoreCandidate, scoreCandidates } from "../src/scoring/editorialScorer";
import { BoiaCandidate } from "../src/ingest/types";

jest.mock("../src/config", () => ({
  config: {
    boiaMinRelevance: 70,
    linkedinMinScore: 60,
    scorePenaltyMaxPoints: 15,
    logLevel: "error",
    logDir: "/tmp",
    linkedinExceptionalScore: 90,
    linkedinSameOrganismMax: 1,
  },
}));
jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function makeCandidate(overrides: Partial<BoiaCandidate> = {}): BoiaCandidate {
  return {
    id: "test-001",
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
      "Para muchos, el 30% de encaje implica inmovilizar capital. Las fintechs deberán y tendrán que " +
      "adaptar su modelo operativo con impacto directo en la tesorería.",
    affectedAudience: ["fintechs", "psp", "compliance", "bancos"],
    contentHash: "a".repeat(64),
    ageHours: 6,
    normalizedSourceUrl: "https://bcra.gob.ar/test",
    ...overrides,
  };
}

describe("editorialScorer", () => {
  describe("scoreCandidate — estructura del resultado", () => {
    it("debe retornar linkedinPublishScore entre 0 y 100", () => {
      const result = scoreCandidate(makeCandidate());
      expect(result.linkedinPublishScore).toBeGreaterThanOrEqual(0);
      expect(result.linkedinPublishScore).toBeLessThanOrEqual(100);
    });

    it("debe incluir todos los campos del scoreBreakdown", () => {
      const result = scoreCandidate(makeCandidate());
      expect(result.scoreBreakdown).toMatchObject({
        organismRelevance: expect.any(Number),
        audienceImpact: expect.any(Number),
        messageClarity: expect.any(Number),
        recency: expect.any(Number),
        conversationPotential: expect.any(Number),
        dataBonus: expect.any(Number),
        technicalityPenalty: expect.any(Number),
        matchedAudience: expect.any(Array),
      });
    });

    it("debe preservar todos los campos del BoiaCandidate", () => {
      const candidate = makeCandidate();
      const result = scoreCandidate(candidate);
      expect(result.id).toBe(candidate.id);
      expect(result.boiaRelevanceScore).toBe(candidate.boiaRelevanceScore);
      expect(result.organism).toBe(candidate.organism);
    });
  });

  describe("scoreCandidate — señal: organismo", () => {
    it("BCRA debe recibir máximo puntaje de organismo", () => {
      const result = scoreCandidate(makeCandidate({ organism: "BCRA" }));
      expect(result.scoreBreakdown.organismRelevance).toBe(25);
    });

    it("CNV debe recibir máximo puntaje de organismo", () => {
      const result = scoreCandidate(makeCandidate({ organism: "CNV" }));
      expect(result.scoreBreakdown.organismRelevance).toBe(25);
    });

    it("Ministerio de Economía debe recibir puntaje medio", () => {
      const result = scoreCandidate(makeCandidate({ organism: "Ministerio de Economía" }));
      expect(result.scoreBreakdown.organismRelevance).toBeGreaterThanOrEqual(10);
      expect(result.scoreBreakdown.organismRelevance).toBeLessThan(25);
    });

    it("organismo desconocido debe recibir puntaje mínimo (5)", () => {
      const result = scoreCandidate(makeCandidate({ organism: "Municipalidad de Chascomús" }));
      expect(result.scoreBreakdown.organismRelevance).toBe(5);
    });

    it("coincidencia parcial debe recibir puntaje intermedio", () => {
      const result = scoreCandidate(makeCandidate({ organism: "BCRA — Gerencia de Supervisión" }));
      // Debería coincidir parcialmente con "bcra"
      expect(result.scoreBreakdown.organismRelevance).toBeGreaterThanOrEqual(15);
    });
  });

  describe("scoreCandidate — señal: audiencia", () => {
    it("audiencia target reconocida debe sumar puntos", () => {
      const withTarget = makeCandidate({ affectedAudience: ["fintechs", "compliance", "bancos"] });
      const withNone = makeCandidate({ affectedAudience: ["estudiantes", "turistas"] });
      expect(scoreCandidate(withTarget).scoreBreakdown.audienceImpact)
        .toBeGreaterThan(scoreCandidate(withNone).scoreBreakdown.audienceImpact);
    });

    it("audienceImpact no debe superar 25", () => {
      const manyAudiences = makeCandidate({
        affectedAudience: ["fintechs", "bancos", "compliance", "legal", "producto", "cfo", "auditores"],
      });
      expect(scoreCandidate(manyAudiences).scoreBreakdown.audienceImpact).toBeLessThanOrEqual(25);
    });

    it("debe retornar las audiencias que coincidieron", () => {
      const result = scoreCandidate(makeCandidate({ affectedAudience: ["fintechs", "compliance"] }));
      expect(result.scoreBreakdown.matchedAudience.length).toBeGreaterThan(0);
    });
  });

  describe("scoreCandidate — señal: claridad del mensaje", () => {
    it("whyItMatters extenso con lenguaje de impacto debe puntuar alto", () => {
      const clear = makeCandidate({
        whyItMatters:
          "Los bancos deberán adaptar sus sistemas antes del 31 de diciembre. " +
          "El impacto afecta directamente a los modelos de crédito. " +
          "Las entidades que no cumplan a partir del 1 de enero quedarán sujetas a sanciones. " +
          "Se exige nueva documentación para todos los modelos de scoring automatizado. " +
          "El plazo corre desde la publicación oficial.",
      });
      const unclear = makeCandidate({ whyItMatters: "Norma relevante." });
      expect(scoreCandidate(clear).scoreBreakdown.messageClarity)
        .toBeGreaterThan(scoreCandidate(unclear).scoreBreakdown.messageClarity);
    });
  });

  describe("scoreCandidate — señal: recencia", () => {
    it("candidato muy reciente debe tener más recency que uno de 5 días", () => {
      const fresh = makeCandidate({ ageHours: 2 });
      const old = makeCandidate({ ageHours: 120 });
      expect(scoreCandidate(fresh).scoreBreakdown.recency)
        .toBeGreaterThan(scoreCandidate(old).scoreBreakdown.recency);
    });

    it("ageHours negativo debe dar recency 0", () => {
      const future = makeCandidate({ ageHours: -5 });
      expect(scoreCandidate(future).scoreBreakdown.recency).toBe(0);
    });
  });

  describe("scoreCandidate — penalidad por tecnicismo", () => {
    it("whyItMatters muy corto debe penalizar", () => {
      const short = makeCandidate({ whyItMatters: "Norma muy técnica sin contexto." });
      const long = makeCandidate({
        whyItMatters:
          "Esta norma impacta directamente en los procesos de onboarding de fintechs. " +
          "Las empresas deberán implementar nuevos controles antes de julio. " +
          "El equipo de compliance y producto tendrá que coordinar los cambios necesarios.",
      });
      expect(scoreCandidate(short).scoreBreakdown.technicalityPenalty)
        .toBeGreaterThan(scoreCandidate(long).scoreBreakdown.technicalityPenalty);
    });

    it("muchas referencias legales deben penalizar", () => {
      const techLegal = makeCandidate({
        summary:
          "Art. 1, Art. 2, Art. 3, Art. 4, Art. 5, Com. A 8123, Res. N° 45, Anexo IV. " +
          "Modifica el Art. 12 del Com. A 7890.",
        whyItMatters:
          "Art. 1, Art. 2, Art. 3, Art. 4, Art. 5, Com. A 8123, Res. N° 45, Anexo IV. " +
          "Modifica el Art. 12 del Com. A 7890 y el Art. 15 del Anexo II.",
      });
      expect(scoreCandidate(techLegal).scoreBreakdown.technicalityPenalty).toBeGreaterThan(0);
    });

    it("technicalityPenalty no debe superar scorePenaltyMaxPoints (15)", () => {
      const worst = makeCandidate({
        whyItMatters: "RG.",
        summary: "Art. 1, Art. 2, Art. 3, Art. 4, Art. 5, Art. 6, Art. 7, Art. 8.",
      });
      expect(scoreCandidate(worst).scoreBreakdown.technicalityPenalty).toBeLessThanOrEqual(15);
    });

    it("score nunca debe ser negativo", () => {
      const worst = makeCandidate({
        organism: "Municipalidad desconocida",
        affectedAudience: [],
        whyItMatters: "Ref.",
        ageHours: 999,
        tags: [],
      });
      expect(scoreCandidate(worst).linkedinPublishScore).toBeGreaterThanOrEqual(0);
    });
  });

  describe("scoreCandidate — bonus", () => {
    it("linkedinAngle provisto debe dar bonus", () => {
      const withAngle = makeCandidate({
        linkedinAngle: "La regulación de PSP cambia el modelo de negocio de las fintechs de pagos.",
      });
      const withoutAngle = makeCandidate({ linkedinAngle: undefined });
      expect(scoreCandidate(withAngle).scoreBreakdown.dataBonus)
        .toBeGreaterThan(scoreCandidate(withoutAngle).scoreBreakdown.dataBonus);
    });

    it("datos numéricos con % deben dar bonus", () => {
      const withData = makeCandidate({
        summary: "Los PSP deberán mantener encajes del 30% sobre el saldo de fondos de clientes.",
        whyItMatters: "El 30% representa un cambio significativo respecto al esquema actual.",
      });
      expect(scoreCandidate(withData).scoreBreakdown.dataBonus).toBeGreaterThan(0);
    });
  });

  describe("scoreCandidates — ordenamiento", () => {
    it("debe ordenar por linkedinPublishScore descendente", () => {
      const candidates = [
        makeCandidate({ id: "low", organism: "Organismo X", affectedAudience: [], ageHours: 200 }),
        makeCandidate({ id: "high", organism: "BCRA", affectedAudience: ["fintechs", "bancos"], ageHours: 1 }),
        makeCandidate({ id: "mid", organism: "UIF", affectedAudience: ["compliance"], ageHours: 24 }),
      ];
      const scored = scoreCandidates(candidates);
      for (let i = 0; i < scored.length - 1; i++) {
        expect(scored[i].linkedinPublishScore).toBeGreaterThanOrEqual(scored[i + 1].linkedinPublishScore);
      }
    });
  });
});
