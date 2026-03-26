import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { config } from "../config";
import { logger } from "../config/logger";

const SCHEMA_VERSION = 3;

let db: Database.Database | null = null;

// ─── Schema base (v1) ─────────────────────────────────────────────────────────

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS posts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash    TEXT    NOT NULL UNIQUE,
  title           TEXT    NOT NULL,
  source_url      TEXT    NOT NULL,
  score           INTEGER NOT NULL,
  status          TEXT    NOT NULL CHECK(status IN (
                    'published', 'skipped', 'failed', 'dry_run', 'pending_approval'
                  )),
  linkedin_urn    TEXT,
  post_text       TEXT,
  error_message   TEXT,
  created_at      DATETIME DEFAULT (datetime('now')),
  published_at    DATETIME
);

CREATE INDEX IF NOT EXISTS idx_posts_hash    ON posts(content_hash);
CREATE INDEX IF NOT EXISTS idx_posts_status  ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);

CREATE TABLE IF NOT EXISTS tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  access_token  TEXT    NOT NULL,
  refresh_token TEXT,
  expires_at    DATETIME NOT NULL,
  scope         TEXT,
  updated_at    DATETIME DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS locks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  pid        INTEGER NOT NULL,
  started_at DATETIME DEFAULT (datetime('now'))
);
`;

// ─── Migraciones ──────────────────────────────────────────────────────────────

const MIGRATIONS: Record<number, string> = {
  2: `
    ALTER TABLE posts ADD COLUMN linkedin_post_id   TEXT;
    ALTER TABLE posts ADD COLUMN failure_reason     TEXT;
    ALTER TABLE posts ADD COLUMN score_breakdown    TEXT;
    ALTER TABLE posts ADD COLUMN copy_text          TEXT;
    ALTER TABLE posts ADD COLUMN published_at_real  DATETIME;
    ALTER TABLE posts ADD COLUMN copy_quality_score INTEGER;
  `,
  3: `
    ALTER TABLE posts ADD COLUMN boia_candidate_id  TEXT;
    ALTER TABLE posts ADD COLUMN boia_relevance_score INTEGER;
    ALTER TABLE posts ADD COLUMN linkedin_publish_score INTEGER;
    ALTER TABLE posts ADD COLUMN organism           TEXT;
    ALTER TABLE posts ADD COLUMN category           TEXT;
    CREATE INDEX IF NOT EXISTS idx_posts_organism ON posts(organism);
    CREATE INDEX IF NOT EXISTS idx_posts_boia_id  ON posts(boia_candidate_id);
  `,
};

// ─── Init ─────────────────────────────────────────────────────────────────────

export function getDb(): Database.Database {
  if (db) return db;

  const dbDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_V1);
  applyMigrations(db);

  logger.debug("Base de datos inicializada", { path: config.dbPath, version: SCHEMA_VERSION });
  return db;
}

function applyMigrations(database: Database.Database): void {
  const currentVersion =
    (database.pragma("user_version") as { user_version: number }[])[0]?.user_version ?? 0;

  if (currentVersion >= SCHEMA_VERSION) return;

  for (let v = currentVersion + 1; v <= SCHEMA_VERSION; v++) {
    const sql = MIGRATIONS[v];
    if (!sql) continue;
    logger.info(`Aplicando migración DB v${v}`);
    for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
      try {
        database.exec(stmt + ";");
      } catch (err) {
        if (String(err).includes("duplicate column name") || String(err).includes("already exists")) {
          logger.debug(`Ya existe: ${stmt.substring(0, 60)}`);
        } else {
          throw err;
        }
      }
    }
  }

  database.pragma(`user_version = ${SCHEMA_VERSION}`);
  logger.info(`DB migrada a versión ${SCHEMA_VERSION}`);
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type PostStatus =
  | "published"
  | "skipped"
  | "failed"
  | "dry_run"
  | "pending_approval";

export type FailureReason =
  | "auth_error"
  | "scope_error"
  | "rate_limit"
  | "validation_error"
  | "network_error"
  | "copy_quality"
  | "boia_score"
  | "linkedin_score"
  | "organism_throttle"
  | "unknown";

export interface PostRecord {
  id?: number;
  content_hash: string;
  title: string;
  source_url: string;
  score: number;
  status: PostStatus;
  // BOIA
  boia_candidate_id?: string | null;
  boia_relevance_score?: number | null;
  organism?: string | null;
  category?: string | null;
  // LinkedIn
  linkedin_urn?: string | null;
  linkedin_post_id?: string | null;
  linkedin_publish_score?: number | null;
  // Copy
  post_text?: string | null;
  copy_text?: string | null;
  copy_quality_score?: number | null;
  // Error
  error_message?: string | null;
  failure_reason?: FailureReason | null;
  score_breakdown?: string | null;
  // Timestamps
  created_at?: string;
  published_at?: string | null;
  published_at_real?: string | null;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function isAlreadyProcessed(contentHash: string): boolean {
  const database = getDb();
  const row = database
    .prepare("SELECT id FROM posts WHERE content_hash = ?")
    .get(contentHash) as { id: number } | undefined;
  return !!row;
}

export function savePost(record: Omit<PostRecord, "id" | "created_at">): number {
  const database = getDb();
  const isPublished = record.status === "published";

  const result = database
    .prepare(`
      INSERT INTO posts (
        content_hash, title, source_url, score, status,
        boia_candidate_id, boia_relevance_score, organism, category,
        linkedin_urn, linkedin_post_id, linkedin_publish_score,
        post_text, copy_text, copy_quality_score,
        error_message, failure_reason, score_breakdown,
        published_at, published_at_real
      ) VALUES (
        @content_hash, @title, @source_url, @score, @status,
        @boia_candidate_id, @boia_relevance_score, @organism, @category,
        @linkedin_urn, @linkedin_post_id, @linkedin_publish_score,
        @post_text, @copy_text, @copy_quality_score,
        @error_message, @failure_reason, @score_breakdown,
        @published_at, @published_at_real
      )
    `)
    .run({
      content_hash: record.content_hash,
      title: record.title,
      source_url: record.source_url,
      score: record.score,
      status: record.status,
      boia_candidate_id: record.boia_candidate_id ?? null,
      boia_relevance_score: record.boia_relevance_score ?? null,
      organism: record.organism ?? null,
      category: record.category ?? null,
      linkedin_urn: record.linkedin_urn ?? null,
      linkedin_post_id: record.linkedin_post_id ?? null,
      linkedin_publish_score: record.linkedin_publish_score ?? null,
      post_text: record.post_text ?? record.copy_text ?? null,
      copy_text: record.copy_text ?? record.post_text ?? null,
      copy_quality_score: record.copy_quality_score ?? null,
      error_message: record.error_message ?? null,
      failure_reason: record.failure_reason ?? null,
      score_breakdown: record.score_breakdown ?? null,
      published_at: isPublished ? new Date().toISOString() : null,
      published_at_real: record.published_at_real ?? null,
    });

  return result.lastInsertRowid as number;
}

export function updatePostStatus(
  contentHash: string,
  status: PostStatus,
  fields: Partial<Pick<
    PostRecord,
    "linkedin_urn" | "linkedin_post_id" | "error_message" | "failure_reason" | "published_at_real"
  >> = {}
): void {
  const database = getDb();
  database
    .prepare(`
      UPDATE posts SET
        status           = @status,
        linkedin_urn     = COALESCE(@linkedin_urn, linkedin_urn),
        linkedin_post_id = COALESCE(@linkedin_post_id, linkedin_post_id),
        error_message    = COALESCE(@error_message, error_message),
        failure_reason   = COALESCE(@failure_reason, failure_reason),
        published_at     = CASE WHEN @status = 'published' THEN datetime('now') ELSE published_at END,
        published_at_real= COALESCE(@published_at_real, published_at_real)
      WHERE content_hash = @content_hash
    `)
    .run({
      status,
      content_hash: contentHash,
      linkedin_urn: fields.linkedin_urn ?? null,
      linkedin_post_id: fields.linkedin_post_id ?? null,
      error_message: fields.error_message ?? null,
      failure_reason: fields.failure_reason ?? null,
      published_at_real: fields.published_at_real ?? null,
    });
}

export function getRecentPosts(limit = 20, status?: PostStatus): PostRecord[] {
  const database = getDb();
  if (status) {
    return database
      .prepare("SELECT * FROM posts WHERE status = ? ORDER BY created_at DESC LIMIT ?")
      .all(status, limit) as PostRecord[];
  }
  return database
    .prepare("SELECT * FROM posts ORDER BY created_at DESC LIMIT ?")
    .all(limit) as PostRecord[];
}

export function getPendingApprovalPosts(): PostRecord[] {
  const database = getDb();
  return database
    .prepare("SELECT * FROM posts WHERE status = 'pending_approval' ORDER BY linkedin_publish_score DESC NULLS LAST")
    .all() as PostRecord[];
}

/** Retorna los organismos publicados en los últimos N minutos */
export function getRecentOrganisms(minutesBack = 60 * 24): string[] {
  const database = getDb();
  const rows = database
    .prepare(`
      SELECT DISTINCT organism FROM posts
      WHERE status = 'published'
        AND organism IS NOT NULL
        AND published_at >= datetime('now', '-${minutesBack} minutes')
    `)
    .all() as { organism: string }[];
  return rows.map((r) => r.organism.toLowerCase());
}

// ─── Tokens ───────────────────────────────────────────────────────────────────

export interface TokenRecord {
  access_token: string;
  refresh_token?: string | null;
  expires_at: string;
  scope?: string | null;
}

export function saveToken(token: TokenRecord): void {
  const database = getDb();
  database.prepare("DELETE FROM tokens").run();
  database
    .prepare(`
      INSERT INTO tokens (access_token, refresh_token, expires_at, scope, updated_at)
      VALUES (@access_token, @refresh_token, @expires_at, @scope, datetime('now'))
    `)
    .run({
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? null,
      expires_at: token.expires_at,
      scope: token.scope ?? null,
    });
}

export function getStoredToken(): TokenRecord | null {
  const database = getDb();
  const row = database
    .prepare("SELECT * FROM tokens ORDER BY updated_at DESC LIMIT 1")
    .get() as TokenRecord | undefined;
  return row ?? null;
}

// ─── Lock ─────────────────────────────────────────────────────────────────────

const LOCK_NAME = "publish_job";

export function acquireLock(): boolean {
  const database = getDb();
  database
    .prepare(
      `DELETE FROM locks WHERE name = ? AND started_at < datetime('now', '-${config.lockMaxAgeMinutes} minutes')`
    )
    .run(LOCK_NAME);

  const existing = database
    .prepare("SELECT pid, started_at FROM locks WHERE name = ?")
    .get(LOCK_NAME) as { pid: number; started_at: string } | undefined;

  if (existing) {
    logger.warn("Lock activo, abortando", {
      pid: existing.pid,
      ageMinutes: Math.round((Date.now() - new Date(existing.started_at).getTime()) / 60000),
    });
    return false;
  }

  try {
    database
      .prepare("INSERT INTO locks (name, pid, started_at) VALUES (?, ?, datetime('now'))")
      .run(LOCK_NAME, process.pid);
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(): void {
  const database = getDb();
  database.prepare("DELETE FROM locks WHERE name = ? AND pid = ?").run(LOCK_NAME, process.pid);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
