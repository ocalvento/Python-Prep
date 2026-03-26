/**
 * Tests de deduplicación y persistencia en DB.
 * Usa una DB en memoria para aislamiento total.
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// Usar una DB de prueba por proceso
const TEST_DB_PATH = path.join(os.tmpdir(), `test-linkedin-${process.pid}.db`);

jest.mock("../src/config", () => ({
  config: {
    dbPath: TEST_DB_PATH,
    logLevel: "error",
    logDir: "/tmp",
    lockMaxAgeMinutes: 30,
    linkedinClientId: "test",
    linkedinClientSecret: "test",
    linkedinRedirectUri: "http://localhost:3000/callback",
    scoreThreshold: 75,
    dryRun: false,
    approvalRequired: false,
    newsInputPath: "/tmp/news.json",
    maxPostsPerRun: 3,
    maxNewsAgeDays: 30,
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
    cronSchedule: "0 9 * * *",
  },
}));

jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  getDb,
  isAlreadyProcessed,
  savePost,
  getRecentPosts,
  saveToken,
  getStoredToken,
  acquireLock,
  releaseLock,
  closeDb,
} from "../src/db";

afterEach(() => {
  closeDb();
});

afterAll(() => {
  closeDb();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  const walPath = TEST_DB_PATH + "-wal";
  const shmPath = TEST_DB_PATH + "-shm";
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
  if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
});

describe("db — deduplicación", () => {
  it("isAlreadyProcessed debe retornar false para hash nuevo", () => {
    expect(isAlreadyProcessed("hash_nuevo_" + Date.now())).toBe(false);
  });

  it("isAlreadyProcessed debe retornar true después de savePost", () => {
    const hash = "dedup_test_" + Date.now();
    savePost({
      content_hash: hash,
      title: "Test post",
      source_url: "https://example.com",
      score: 80,
      status: "published",
    });
    expect(isAlreadyProcessed(hash)).toBe(true);
  });

  it("guardar el mismo content_hash dos veces debe lanzar error (UNIQUE constraint)", () => {
    const hash = "duplicate_hash_" + Date.now();
    savePost({
      content_hash: hash,
      title: "Post original",
      source_url: "https://example.com/1",
      score: 80,
      status: "published",
    });
    expect(() =>
      savePost({
        content_hash: hash,
        title: "Intento duplicado",
        source_url: "https://example.com/2",
        score: 85,
        status: "published",
      })
    ).toThrow();
  });
});

describe("db — savePost y getRecentPosts", () => {
  it("debe guardar todos los campos opcionales correctamente", () => {
    const hash = "full_record_" + Date.now();
    savePost({
      content_hash: hash,
      title: "Post completo",
      source_url: "https://example.com",
      score: 85,
      status: "published",
      linkedin_urn: "urn:li:share:123456789",
      linkedin_post_id: "123456789",
      copy_text: "Texto del post",
      post_text: "Texto del post",
      score_breakdown: JSON.stringify({ recency: 25, tagRelevance: 20 }),
      copy_quality_score: 75,
      failure_reason: null,
    });

    // Buscar por content_hash específico en lugar de asumir orden
    const db = getDb();
    const post = db.prepare("SELECT * FROM posts WHERE content_hash = ?").get(hash) as
      | Record<string, unknown>
      | undefined;
    expect(post).toBeDefined();
    expect(post!["content_hash"]).toBe(hash);
    expect(post!["linkedin_urn"]).toBe("urn:li:share:123456789");
    expect(post!["linkedin_post_id"]).toBe("123456789");
    expect(post!["copy_quality_score"]).toBe(75);
  });

  it("debe soportar todos los status válidos", () => {
    const statuses = ["published", "skipped", "failed", "dry_run", "pending_approval"] as const;
    for (const status of statuses) {
      const hash = `status_test_${status}_${Date.now()}`;
      expect(() =>
        savePost({
          content_hash: hash,
          title: `Post ${status}`,
          source_url: "https://example.com",
          score: 80,
          status,
        })
      ).not.toThrow();
    }
  });

  it("getRecentPosts debe filtrar por status", () => {
    const hash1 = "filter_pub_" + Date.now();
    const hash2 = "filter_fail_" + (Date.now() + 1);

    savePost({ content_hash: hash1, title: "Pub", source_url: "https://ex.com", score: 80, status: "published" });
    savePost({ content_hash: hash2, title: "Fail", source_url: "https://ex.com", score: 70, status: "failed" });

    const published = getRecentPosts(100, "published");
    const failed = getRecentPosts(100, "failed");

    expect(published.every((p) => p.status === "published")).toBe(true);
    expect(failed.every((p) => p.status === "failed")).toBe(true);
  });
});

describe("db — tokens", () => {
  it("debe guardar y recuperar un token", () => {
    const token = {
      access_token: "test_access_token",
      refresh_token: "test_refresh_token",
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      scope: "openid profile w_member_social",
    };
    saveToken(token);
    const stored = getStoredToken();
    expect(stored?.access_token).toBe(token.access_token);
    expect(stored?.refresh_token).toBe(token.refresh_token);
    expect(stored?.scope).toBe(token.scope);
  });

  it("debe reemplazar el token anterior (upsert)", () => {
    saveToken({ access_token: "token_v1", expires_at: new Date(Date.now() + 3600000).toISOString() });
    saveToken({ access_token: "token_v2", expires_at: new Date(Date.now() + 7200000).toISOString() });
    const stored = getStoredToken();
    expect(stored?.access_token).toBe("token_v2");
  });

  it("debe retornar null si no hay tokens", () => {
    // Limpiar tokens
    const db = getDb();
    db.prepare("DELETE FROM tokens").run();
    expect(getStoredToken()).toBeNull();
  });
});

describe("db — lock de concurrencia", () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM locks").run();
  });

  it("acquireLock debe retornar true la primera vez", () => {
    expect(acquireLock()).toBe(true);
    releaseLock();
  });

  it("acquireLock debe retornar false si ya hay un lock activo", () => {
    expect(acquireLock()).toBe(true);
    // Simular que otro proceso intenta adquirir el lock (sin hacer releaseLock primero)
    // Insertamos directamente con un PID diferente
    const db = getDb();
    db.prepare("DELETE FROM locks").run(); // Limpiar el lock actual
    db.prepare("INSERT INTO locks (name, pid, started_at) VALUES ('publish_job', 99999, datetime('now'))").run();

    expect(acquireLock()).toBe(false);
    db.prepare("DELETE FROM locks").run();
  });

  it("releaseLock debe limpiar solo el lock del proceso actual", () => {
    acquireLock();
    releaseLock();
    const db = getDb();
    const lock = db.prepare("SELECT * FROM locks WHERE name = 'publish_job'").get();
    expect(lock).toBeUndefined();
  });
});

describe("db — migración de esquema", () => {
  it("debe inicializar con la versión de esquema correcta", () => {
    const db = getDb();
    const version = (db.pragma("user_version") as { user_version: number }[])[0]?.user_version;
    expect(version).toBeGreaterThanOrEqual(2);
  });

  it("debe tener las columnas de v2 disponibles", () => {
    const db = getDb();
    // Si las columnas existen, esta query no debe fallar
    expect(() => {
      db.prepare("SELECT linkedin_post_id, failure_reason, score_breakdown, copy_text, published_at_real FROM posts LIMIT 1").all();
    }).not.toThrow();
  });
});
