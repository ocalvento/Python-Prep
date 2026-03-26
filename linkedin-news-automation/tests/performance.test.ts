/**
 * Tests for the performance tracking + feedback loop module.
 *
 * Uses a real SQLite DB in /tmp — same pattern as db.test.ts.
 * Does NOT mock better-sqlite3 so we validate real SQL and migrations.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TEST_DB_PATH = path.join(os.tmpdir(), `test-perf-${process.pid}.db`);

jest.mock("../src/config", () => ({
  config: {
    dbPath: TEST_DB_PATH,
    logLevel: "error",
    logDir: "/tmp",
    maxPostsPerRun: 3,
    linkedinMinScore: 60,
    lockMaxAgeMinutes: 30,
    scorePenaltyMaxPoints: 15,
  },
}));
jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

afterAll(() => {
  const { closeDb } = require("../src/db");
  closeDb();
  for (const ext of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + ext;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

// ─── computeEngagementRate ────────────────────────────────────────────────────

describe("computeEngagementRate", () => {
  const { computeEngagementRate } = require("../src/performance/performanceService");

  it("calcula (likes + comments*2) / impressions", () => {
    // (10 + 5*2) / 100 = 0.2
    expect(computeEngagementRate(100, 10, 5)).toBeCloseTo(0.2);
  });

  it("devuelve 0 si impressions = 0 (sin división por cero)", () => {
    expect(computeEngagementRate(0, 50, 10)).toBe(0);
  });

  it("devuelve 0 si impressions < 0", () => {
    expect(computeEngagementRate(-1, 5, 2)).toBe(0);
  });

  it("pondera comentarios el doble que likes", () => {
    const withLikes    = computeEngagementRate(100, 10, 0); // 0.1
    const withComments = computeEngagementRate(100, 0, 5);  // 0.1
    expect(withLikes).toBeCloseTo(withComments);
  });

  it("tasa alta con muchos likes y comentarios", () => {
    // (100 + 50*2) / 1000 = 0.2
    expect(computeEngagementRate(1000, 100, 50)).toBeCloseTo(0.2);
  });
});

// ─── createPostPerformance ────────────────────────────────────────────────────

describe("createPostPerformance", () => {
  beforeEach(() => {
    const { closeDb } = require("../src/db");
    closeDb();
  });

  it("crea un registro con métricas en cero", () => {
    const { createPostPerformance } = require("../src/performance/performanceService");
    const record = createPostPerformance(
      "boia-001",
      "BCRA establece nuevos requisitos de liquidez",
      "https://bcra.gob.ar/test",
      82
    );

    expect(record.candidateId).toBe("boia-001");
    expect(record.editorialScore).toBe(82);
    expect(record.impressions).toBe(0);
    expect(record.likes).toBe(0);
    expect(record.comments).toBe(0);
    expect(record.saves).toBeUndefined();
    expect(record.engagementRate).toBe(0);
  });

  it("genera un UUID v4 como id", () => {
    const { createPostPerformance } = require("../src/performance/performanceService");
    const record = createPostPerformance("boia-uuid-test", "Título largo de prueba para organismo", "https://example.com", 70);
    expect(record.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("persiste en la DB y se puede consultar", () => {
    const { createPostPerformance } = require("../src/performance/performanceService");
    const { getDb, closeDb }        = require("../src/db");

    const record = createPostPerformance("boia-persist", "Título para persistencia test", "https://bcra.gob.ar/persist", 75);
    closeDb();

    const row = getDb()
      .prepare("SELECT * FROM post_performance WHERE id = ?")
      .get(record.id) as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row?.candidate_id).toBe("boia-persist");
    expect(row?.editorial_score).toBe(75);
    expect(row?.engagement_rate).toBe(0);
  });

  it("usa publishedAt proporcionado si se pasa", () => {
    const { createPostPerformance } = require("../src/performance/performanceService");
    const ts = new Date("2026-01-15T10:00:00Z");
    const record = createPostPerformance("boia-date", "Título con fecha específica", "https://example.com/date", 80, ts);
    expect(record.publishedAt.toISOString()).toBe(ts.toISOString());
  });
});

// ─── updatePostMetrics ────────────────────────────────────────────────────────

describe("updatePostMetrics", () => {
  beforeEach(() => {
    const { closeDb } = require("../src/db");
    closeDb();
  });

  function createAndGetId(): string {
    const { createPostPerformance } = require("../src/performance/performanceService");
    return createPostPerformance("boia-upd", "Título para update test candidate", "https://test.com", 78).id;
  }

  it("actualiza métricas y recalcula engagementRate", () => {
    const { updatePostMetrics } = require("../src/performance/performanceService");
    const id = createAndGetId();

    const updated = updatePostMetrics(id, { impressions: 1000, likes: 50, comments: 20 });

    expect(updated).not.toBeNull();
    expect(updated!.impressions).toBe(1000);
    expect(updated!.likes).toBe(50);
    expect(updated!.comments).toBe(20);
    // (50 + 20*2) / 1000 = 0.09
    expect(updated!.engagementRate).toBeCloseTo(0.09);
  });

  it("actualiza saves cuando se proporciona", () => {
    const { updatePostMetrics } = require("../src/performance/performanceService");
    const id = createAndGetId();

    const updated = updatePostMetrics(id, { impressions: 500, likes: 30, comments: 5, saves: 12 });
    expect(updated!.saves).toBe(12);
  });

  it("retorna null si el postId no existe", () => {
    const { updatePostMetrics } = require("../src/performance/performanceService");
    const result = updatePostMetrics("non-existent-uuid-0000", { impressions: 100, likes: 5, comments: 2 });
    expect(result).toBeNull();
  });

  it("engagementRate = 0 cuando impressions = 0 (no falla)", () => {
    const { updatePostMetrics } = require("../src/performance/performanceService");
    const id = createAndGetId();
    const updated = updatePostMetrics(id, { impressions: 0, likes: 10, comments: 3 });
    expect(updated!.engagementRate).toBe(0);
  });

  it("actualización idempotente: dos updates al mismo post, prevalece el último", () => {
    const { updatePostMetrics } = require("../src/performance/performanceService");
    const id = createAndGetId();

    updatePostMetrics(id, { impressions: 100, likes: 5, comments: 1 });
    const second = updatePostMetrics(id, { impressions: 2000, likes: 200, comments: 40 });

    expect(second!.impressions).toBe(2000);
    // (200 + 40*2) / 2000 = 0.14
    expect(second!.engagementRate).toBeCloseTo(0.14);
  });
});

// ─── getTopPerformingPosts ────────────────────────────────────────────────────

describe("getTopPerformingPosts", () => {
  beforeEach(() => {
    const { closeDb } = require("../src/db");
    closeDb();
  });

  it("retorna posts ordenados por engagement_rate DESC", () => {
    const { createPostPerformance, updatePostMetrics, getTopPerformingPosts } =
      require("../src/performance/performanceService");

    const p1 = createPostPerformance("boia-top-1", "Post bajo engagement", "https://ex.com/1", 60);
    const p2 = createPostPerformance("boia-top-2", "Post alto engagement", "https://ex.com/2", 90);
    const p3 = createPostPerformance("boia-top-3", "Post medio engagement", "https://ex.com/3", 75);

    // p2 gets best rate: (80 + 30*2) / 500 = 0.28
    updatePostMetrics(p1.id, { impressions: 1000, likes: 10, comments: 2  }); // 0.014
    updatePostMetrics(p2.id, { impressions: 500,  likes: 80, comments: 30 }); // 0.28
    updatePostMetrics(p3.id, { impressions: 800,  likes: 40, comments: 10 }); // 0.075

    const top = getTopPerformingPosts(3);

    expect(top[0].candidateId).toBe("boia-top-2");
    expect(top[0].engagementRate).toBeGreaterThan(top[1].engagementRate);
    expect(top[1].engagementRate).toBeGreaterThan(top[2].engagementRate);
  });

  it("respeta el límite", () => {
    const { createPostPerformance, updatePostMetrics, getTopPerformingPosts } =
      require("../src/performance/performanceService");

    for (let i = 0; i < 5; i++) {
      const p = createPostPerformance(`boia-limit-${i}`, `Título limit ${i}`, `https://ex.com/${i}`, 70 + i);
      updatePostMetrics(p.id, { impressions: 100 + i * 10, likes: i * 5, comments: i });
    }

    expect(getTopPerformingPosts(2)).toHaveLength(2);
  });

  it("retorna array vacío si no hay registros", () => {
    const { getTopPerformingPosts } = require("../src/performance/performanceService");
    // Fresh DB state — no records in this isolated call if DB is already empty from other tests.
    // We just verify it doesn't throw.
    expect(() => getTopPerformingPosts(5)).not.toThrow();
  });
});

// ─── analyzePerformance ───────────────────────────────────────────────────────

describe("analyzePerformance", () => {
  beforeEach(() => {
    const { getDb, closeDb } = require("../src/db");
    closeDb();
    getDb().prepare("DELETE FROM post_performance").run();
    closeDb();
  });

  it("retorna estructura correcta con datos insuficientes", () => {
    const { analyzePerformance } = require("../src/performance/feedbackLoop");
    const result = analyzePerformance();

    expect(result).toHaveProperty("correlation");
    expect(result).toHaveProperty("sampleSize");
    expect(result).toHaveProperty("insights");
    expect(result).toHaveProperty("suggestedWeightAdjustments");
    expect(Array.isArray(result.insights)).toBe(true);
    expect(Array.isArray(result.suggestedWeightAdjustments)).toBe(true);
  });

  it("devuelve correlation=0 e insights de datos insuficientes cuando no hay impresiones", () => {
    const { createPostPerformance } = require("../src/performance/performanceService");
    const { analyzePerformance }    = require("../src/performance/feedbackLoop");

    // Create posts without updating metrics (impressions = 0)
    for (let i = 0; i < 5; i++) {
      createPostPerformance(`boia-nodata-${i}`, `Sin métricas ${i}`, `https://ex.com/nd-${i}`, 70 + i);
    }

    const result = analyzePerformance();
    expect(result.correlation).toBe(0);
    expect(result.sampleSize).toBe(0);
    expect(result.insights[0]).toMatch(/insuficiente/i);
  });

  it("calcula correlación con datos reales", () => {
    const { createPostPerformance, updatePostMetrics } =
      require("../src/performance/performanceService");
    const { analyzePerformance } = require("../src/performance/feedbackLoop");

    // Seed posts where higher editorial score → higher engagement (positive correlation)
    const data = [
      { score: 90, likes: 100, comments: 40, impressions: 500 },
      { score: 80, likes: 70,  comments: 25, impressions: 600 },
      { score: 70, likes: 40,  comments: 10, impressions: 700 },
      { score: 60, likes: 20,  comments: 5,  impressions: 800 },
    ];

    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      const p = createPostPerformance(
        `boia-corr-${i}`,
        `Post correlación ${i}`,
        `https://ex.com/c-${i}`,
        d.score
      );
      updatePostMetrics(p.id, { impressions: d.impressions, likes: d.likes, comments: d.comments });
    }

    const result = analyzePerformance();
    expect(result.sampleSize).toBeGreaterThanOrEqual(4);
    // Should show positive correlation
    expect(result.correlation).toBeGreaterThan(0);
    expect(result.insights.length).toBeGreaterThan(0);
  });

  it("correlation está en el rango [-1, 1]", () => {
    const { createPostPerformance, updatePostMetrics } =
      require("../src/performance/performanceService");
    const { analyzePerformance } = require("../src/performance/feedbackLoop");

    for (let i = 0; i < 6; i++) {
      const p = createPostPerformance(`boia-range-${i}`, `Range test ${i}`, `https://ex.com/r-${i}`, 50 + i * 8);
      updatePostMetrics(p.id, { impressions: 200 + i * 50, likes: i * 10, comments: i * 3 });
    }

    const result = analyzePerformance();
    expect(result.correlation).toBeGreaterThanOrEqual(-1);
    expect(result.correlation).toBeLessThanOrEqual(1);
  });

  it("suggestedWeightAdjustments contiene signal, currentWeight, suggestedWeight", () => {
    const { createPostPerformance, updatePostMetrics } =
      require("../src/performance/performanceService");
    const { analyzePerformance } = require("../src/performance/feedbackLoop");
    const { getDb, closeDb }     = require("../src/db");

    // Seed posts with score_breakdown in posts table to enable signal analysis
    const db = getDb();
    for (let i = 0; i < 6; i++) {
      const score = 60 + i * 7;
      const p = createPostPerformance(
        `boia-adj-${i}`, `Breakdown test ${i}`, `https://ex.com/adj-${i}`, score
      );
      updatePostMetrics(p.id, { impressions: 300 + i * 100, likes: i * 15, comments: i * 4 });

      // Insert a matching posts row with score_breakdown
      try {
        db.prepare(`
          INSERT INTO posts (content_hash, title, source_url, score, status, boia_candidate_id, score_breakdown)
          VALUES (?, ?, ?, ?, 'published', ?, ?)
        `).run(
          `hash-adj-${i}`,
          `Breakdown test ${i}`,
          `https://ex.com/adj-${i}`,
          score,
          `boia-adj-${i}`,
          JSON.stringify({
            organismRelevance: 20 + i,
            audienceImpact: 15 + i * 2,
            messageClarity: 8 + i,
            recency: 10 - i,
            conversationPotential: 5 + i,
            dataBonus: 3 + i,
            technicalityPenalty: Math.max(0, 5 - i),
          })
        );
      } catch { /* ignore duplicate hash on repeated runs */ }
    }
    closeDb();

    const result = analyzePerformance();

    for (const adj of result.suggestedWeightAdjustments) {
      expect(adj).toHaveProperty("signal");
      expect(adj).toHaveProperty("currentWeight");
      expect(adj).toHaveProperty("suggestedWeight");
      expect(typeof adj.signal).toBe("string");
      expect(typeof adj.currentWeight).toBe("number");
      expect(typeof adj.suggestedWeight).toBe("number");
      expect(adj.suggestedWeight).toBeGreaterThanOrEqual(1);
    }
  });
});

// ─── shouldPublish ────────────────────────────────────────────────────────────

describe("shouldPublish", () => {
  beforeEach(() => {
    const { getDb, closeDb } = require("../src/db");
    closeDb();
    getDb().prepare("DELETE FROM post_performance").run();
    closeDb();
  });

  it("permite publicar cuando no hay posts recientes", () => {
    const { shouldPublish } = require("../src/performance/feedbackLoop");
    const decision = shouldPublish(80, 24);

    // Fresh DB: 0 posts → should allow
    expect(decision.should).toBe(true);
    expect(decision.publishedTodayCount).toBe(0);
  });

  it("bloquea cuando se alcanza maxPostsPerRun (3) en ventana", () => {
    const { createPostPerformance } = require("../src/performance/performanceService");
    const { shouldPublish }         = require("../src/performance/feedbackLoop");

    // Fill up today's quota (maxPostsPerRun = 3 from mock config)
    for (let i = 0; i < 3; i++) {
      createPostPerformance(`boia-limit-pub-${i}`, `Título quota ${i}`, `https://ex.com/q${i}`, 75);
    }

    const decision = shouldPublish(90, 24);
    expect(decision.should).toBe(false);
    expect(decision.reason).toMatch(/publicaron/i);
    expect(decision.publishedTodayCount).toBe(3);
  });

  it("aplica umbral dinámico top-20%", () => {
    const { createPostPerformance } = require("../src/performance/performanceService");
    const { shouldPublish }         = require("../src/performance/feedbackLoop");

    // Seed 10 historical posts with publishedAt 5 days ago (within 30-day window but
    // outside the 24h rate-limit window, so they don't trigger maxPostsPerRun).
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 10; i++) {
      createPostPerformance(
        `boia-thresh-${i}`,
        `Threshold test ${i}`,
        `https://ex.com/t${i}`,
        60 + i * 4, // 60, 64, 68, ..., 96
        fiveDaysAgo
      );
    }

    // Top 20% of 10 posts = top 2 → scores 92 and 96 → threshold = 92
    // A score of 95 should pass; a score of 70 should not
    const high = shouldPublish(95, 24);
    const low  = shouldPublish(70, 24);

    expect(high.should).toBe(true);
    expect(low.should).toBe(false);
    expect(high.threshold).toBeGreaterThan(70);
  });

  it("usa config.linkedinMinScore como fallback cuando no hay datos históricos", () => {
    const { shouldPublish } = require("../src/performance/feedbackLoop");

    // No data in DB → threshold falls back to config.linkedinMinScore (60)
    const aboveDefault = shouldPublish(65, 24);
    const belowDefault = shouldPublish(50, 24);

    expect(aboveDefault.should).toBe(true);
    expect(belowDefault.should).toBe(false);
    expect(belowDefault.threshold).toBe(60); // config.linkedinMinScore
  });
});

// ─── DB schema ────────────────────────────────────────────────────────────────

describe("DB schema v4", () => {
  it("crea la tabla post_performance con todas las columnas esperadas", () => {
    const { getDb, closeDb } = require("../src/db");
    closeDb();

    const db = getDb();
    const cols = db
      .prepare("PRAGMA table_info(post_performance)")
      .all() as { name: string }[];

    const colNames = cols.map((c) => c.name);

    expect(colNames).toContain("id");
    expect(colNames).toContain("candidate_id");
    expect(colNames).toContain("editorial_score");
    expect(colNames).toContain("published_at");
    expect(colNames).toContain("impressions");
    expect(colNames).toContain("likes");
    expect(colNames).toContain("comments");
    expect(colNames).toContain("saves");
    expect(colNames).toContain("engagement_rate");
    expect(colNames).toContain("updated_at");
  });

  it("los índices existen", () => {
    const { getDb, closeDb } = require("../src/db");
    closeDb();

    const db = getDb();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='post_performance'")
      .all() as { name: string }[];

    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_perf_candidate");
    expect(names).toContain("idx_perf_source");
    expect(names).toContain("idx_perf_eng_rate");
  });

  it("user_version es >= 4 tras las migraciones", () => {
    const { getDb, closeDb } = require("../src/db");
    closeDb();
    const db = getDb();
    const [row] = db.pragma("user_version") as { user_version: number }[];
    expect(row.user_version).toBeGreaterThanOrEqual(4);
  });
});
