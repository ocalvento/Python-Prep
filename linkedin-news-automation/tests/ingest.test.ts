import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { readNewsFile, computeHash } from "../src/ingest/newsReader";

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

const VALID_ITEM = {
  title: "Artículo de prueba sobre tecnología",
  summary: "Este es un resumen suficientemente largo para pasar la validación. Contiene información relevante.",
  url: "https://example.com/articulo",
  source: "Test Source",
  published_at: "2026-03-24T10:00:00Z",
  tags: ["tecnología", "ia"],
};

function writeTempFile(data: unknown): string {
  const tmpPath = path.join(os.tmpdir(), `test-news-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(data));
  return tmpPath;
}

describe("ingest/newsReader", () => {
  describe("readNewsFile", () => {
    it("debe leer y parsear un archivo válido", () => {
      const filePath = writeTempFile([VALID_ITEM]);
      const items = readNewsFile(filePath);
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe(VALID_ITEM.title);
      fs.unlinkSync(filePath);
    });

    it("debe agregar contentHash y ageHours a cada ítem", () => {
      const filePath = writeTempFile([VALID_ITEM]);
      const items = readNewsFile(filePath);
      expect(items[0]).toHaveProperty("contentHash");
      expect(items[0]).toHaveProperty("ageHours");
      expect(typeof items[0].contentHash).toBe("string");
      expect(items[0].contentHash).toHaveLength(64); // SHA-256 hex
      fs.unlinkSync(filePath);
    });

    it("debe filtrar ítems inválidos con warning", () => {
      const invalidItem = { title: "x", url: "no-es-url" };
      const filePath = writeTempFile([VALID_ITEM, invalidItem]);
      const items = readNewsFile(filePath);
      expect(items).toHaveLength(1);
      fs.unlinkSync(filePath);
    });

    it("debe lanzar error si el archivo no existe", () => {
      expect(() => readNewsFile("/no/existe/path.json")).toThrow();
    });

    it("debe lanzar error si el contenido no es un array", () => {
      const filePath = writeTempFile({ item: VALID_ITEM });
      expect(() => readNewsFile(filePath)).toThrow("debe contener un array");
      fs.unlinkSync(filePath);
    });

    it("debe calcular ageHours correctamente para noticia reciente", () => {
      const recentItem = {
        ...VALID_ITEM,
        published_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 horas atrás
      };
      const filePath = writeTempFile([recentItem]);
      const items = readNewsFile(filePath);
      expect(items[0].ageHours).toBeGreaterThan(1.9);
      expect(items[0].ageHours).toBeLessThan(2.1);
      fs.unlinkSync(filePath);
    });
  });

  describe("computeHash", () => {
    it("debe generar el mismo hash para los mismos inputs", () => {
      const h1 = computeHash("Título", "https://example.com");
      const h2 = computeHash("Título", "https://example.com");
      expect(h1).toBe(h2);
    });

    it("debe generar hashes distintos para inputs distintos", () => {
      const h1 = computeHash("Título A", "https://example.com/a");
      const h2 = computeHash("Título B", "https://example.com/b");
      expect(h1).not.toBe(h2);
    });

    it("debe generar un hash de 64 caracteres (SHA-256 hex)", () => {
      const h = computeHash("test", "https://test.com");
      expect(h).toHaveLength(64);
    });
  });
});
