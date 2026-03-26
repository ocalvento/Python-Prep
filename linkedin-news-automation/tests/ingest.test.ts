import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { readNewsFile, computeHash, normalizeUrl } from "../src/ingest/newsReader";

jest.mock("../src/config", () => ({
  config: {
    newsInputPath: "/tmp/test-news.json",
    logLevel: "error",
    logDir: "/tmp",
    scoreThreshold: 75,
    dryRun: false,
    dbPath: "/tmp/test.db",
    cronSchedule: "0 9 * * *",
    linkedinClientId: "test",
    linkedinClientSecret: "test",
    linkedinRedirectUri: "http://localhost:3000/callback",
    maxNewsAgeDays: 30,
    maxPostsPerRun: 3,
    approvalRequired: false,
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
    lockMaxAgeMinutes: 30,
  },
}));

jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const VALID_ITEM = {
  title: "Artículo completo sobre tecnología e innovación digital",
  summary:
    "Este es un resumen suficientemente largo para pasar la validación. " +
    "Contiene información relevante sobre el impacto tecnológico y sus consecuencias.",
  url: "https://example.com/articulo",
  source: "Test Source",
  published_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h atrás
  tags: ["tecnología", "ia"],
};

function writeTmpFile(data: unknown, suffix = ""): string {
  const p = path.join(os.tmpdir(), `test-news-${Date.now()}${suffix}.json`);
  fs.writeFileSync(p, JSON.stringify(data), "utf-8");
  return p;
}

describe("ingest/newsReader", () => {
  describe("readNewsFile — happy path", () => {
    it("debe leer y parsear un archivo válido", () => {
      const fp = writeTmpFile([VALID_ITEM]);
      const items = readNewsFile(fp);
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe(VALID_ITEM.title.toLowerCase().replace(/[.!?]+$/, ""));
      fs.unlinkSync(fp);
    });

    it("debe agregar contentHash (64 chars) y ageHours", () => {
      const fp = writeTmpFile([VALID_ITEM]);
      const items = readNewsFile(fp);
      expect(items[0].contentHash).toHaveLength(64);
      expect(items[0].ageHours).toBeCloseTo(2, 0);
      fs.unlinkSync(fp);
    });

    it("debe normalizar title y source a lowercase sin puntuación final", () => {
      const item = { ...VALID_ITEM, title: "Título con Mayúsculas y Punto.", source: "Fuente RSS." };
      const fp = writeTmpFile([item]);
      const items = readNewsFile(fp);
      expect(items[0].title).toBe("título con mayúsculas y punto");
      expect(items[0].source).toBe("fuente rss");
      fs.unlinkSync(fp);
    });

    it("debe normalizar tags a lowercase", () => {
      const item = { ...VALID_ITEM, tags: ["IA", "Machine Learning", "Startup"] };
      const fp = writeTmpFile([item]);
      const items = readNewsFile(fp);
      expect(items[0].tags).toEqual(["ia", "machine learning", "startup"]);
      fs.unlinkSync(fp);
    });

    it("debe usar canonical_url para el hash si está presente", () => {
      const canonical = "https://canonical.example.com/articulo-real";
      const item = { ...VALID_ITEM, canonical_url: canonical };
      const fp = writeTmpFile([item]);
      const items = readNewsFile(fp);
      const expectedHash = computeHash(
        items[0].title, // ya normalizado
        normalizeUrl(canonical)
      );
      expect(items[0].contentHash).toBe(expectedHash);
      fs.unlinkSync(fp);
    });
  });

  describe("readNewsFile — deduplicación", () => {
    it("debe detectar duplicados dentro del mismo archivo", () => {
      const fp = writeTmpFile([VALID_ITEM, VALID_ITEM]);
      const items = readNewsFile(fp);
      expect(items).toHaveLength(1);
      fs.unlinkSync(fp);
    });

    it("URLs con tracking params iguales deben producir el mismo hash", () => {
      const itemA = { ...VALID_ITEM, url: "https://example.com/articulo?utm_source=twitter&utm_medium=social" };
      const itemB = { ...VALID_ITEM, url: "https://example.com/articulo?fbclid=abc123" };
      const fp = writeTmpFile([itemA, itemB]);
      const items = readNewsFile(fp);
      // Ambos deben normalizar a la misma URL, produciendo el mismo hash → solo 1
      expect(items).toHaveLength(1);
      fs.unlinkSync(fp);
    });

    it("URLs con query params relevantes distintos deben ser distintas", () => {
      const itemA = { ...VALID_ITEM, url: "https://example.com/search?q=ia" };
      const itemB = { ...VALID_ITEM, url: "https://example.com/search?q=fintech", title: "Otro título completamente distinto" };
      const fp = writeTmpFile([itemA, itemB]);
      const items = readNewsFile(fp);
      expect(items).toHaveLength(2);
      fs.unlinkSync(fp);
    });
  });

  describe("readNewsFile — validación", () => {
    it("debe filtrar ítems inválidos con warning, no fallar", () => {
      const invalid = { title: "x", url: "no-es-url" };
      const fp = writeTmpFile([VALID_ITEM, invalid]);
      const items = readNewsFile(fp);
      expect(items).toHaveLength(1);
      fs.unlinkSync(fp);
    });

    it("debe rechazar título demasiado corto (< 10 chars)", () => {
      const item = { ...VALID_ITEM, title: "Corto" };
      const fp = writeTmpFile([item]);
      const items = readNewsFile(fp);
      expect(items).toHaveLength(0);
      fs.unlinkSync(fp);
    });

    it("debe rechazar resumen demasiado corto (< 50 chars)", () => {
      const item = { ...VALID_ITEM, summary: "Muy corto." };
      const fp = writeTmpFile([item]);
      const items = readNewsFile(fp);
      expect(items).toHaveLength(0);
      fs.unlinkSync(fp);
    });

    it("debe rechazar fechas futuras", () => {
      const future = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      const item = { ...VALID_ITEM, published_at: future };
      const fp = writeTmpFile([item]);
      const items = readNewsFile(fp);
      expect(items).toHaveLength(0);
      fs.unlinkSync(fp);
    });

    it("debe rechazar noticias más antiguas que maxNewsAgeDays", () => {
      const veryOld = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 días
      const item = { ...VALID_ITEM, published_at: veryOld };
      const fp = writeTmpFile([item]);
      const items = readNewsFile(fp);
      expect(items).toHaveLength(0);
      fs.unlinkSync(fp);
    });

    it("debe lanzar error si el archivo no existe", () => {
      expect(() => readNewsFile("/no/existe/path.json")).toThrow("no encontrado");
    });

    it("debe lanzar error si el contenido no es un array JSON", () => {
      const fp = writeTmpFile({ item: VALID_ITEM });
      expect(() => readNewsFile(fp)).toThrow("array JSON");
      fs.unlinkSync(fp);
    });
  });

  describe("normalizeUrl", () => {
    it("debe eliminar parámetros de tracking", () => {
      const url = normalizeUrl("https://example.com/post?utm_source=twitter&id=123");
      expect(url).not.toContain("utm_source");
      expect(url).toContain("id=123");
    });

    it("debe normalizar a https", () => {
      expect(normalizeUrl("http://example.com/")).toContain("https://");
    });

    it("debe eliminar el hash/fragmento", () => {
      expect(normalizeUrl("https://example.com/post#seccion")).not.toContain("#");
    });

    it("debe eliminar trailing slashes del path", () => {
      const url = normalizeUrl("https://example.com/post/");
      expect(url.endsWith("/")).toBe(false);
    });
  });

  describe("computeHash", () => {
    it("mismo input → mismo hash", () => {
      expect(computeHash("título", "https://example.com")).toBe(
        computeHash("título", "https://example.com")
      );
    });

    it("input distinto → hash distinto", () => {
      expect(computeHash("a", "https://a.com")).not.toBe(
        computeHash("b", "https://b.com")
      );
    });

    it("debe producir SHA-256 hex de 64 caracteres", () => {
      expect(computeHash("test", "https://test.com")).toHaveLength(64);
    });
  });
});
