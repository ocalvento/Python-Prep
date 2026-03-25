import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { config } from "../config";
import { logger } from "../config/logger";

let db: Database.Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash  TEXT    NOT NULL UNIQUE,
  title         TEXT    NOT NULL,
  source_url    TEXT    NOT NULL,
  score         INTEGER NOT NULL,
  status        TEXT    NOT NULL CHECK(status IN ('published', 'skipped', 'failed', 'dry_run')),
  linkedin_urn  TEXT,
  post_text     TEXT,
  error_message TEXT,
  created_at    DATETIME DEFAULT (datetime('now')),
  published_at  DATETIME
);

CREATE INDEX IF NOT EXISTS idx_posts_hash   ON posts(content_hash);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);

CREATE TABLE IF NOT EXISTS tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  access_token  TEXT    NOT NULL,
  refresh_token TEXT,
  expires_at    DATETIME NOT NULL,
  scope         TEXT,
  updated_at    DATETIME DEFAULT (datetime('now'))
);
`;

export function getDb(): Database.Database {
  if (db) return db;

  const dbDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  logger.debug("Base de datos inicializada", { path: config.dbPath });
  return db;
}

// ─── Post records ────────────────────────────────────────────────────────────

export interface PostRecord {
  id?: number;
  content_hash: string;
  title: string;
  source_url: string;
  score: number;
  status: "published" | "skipped" | "failed" | "dry_run";
  linkedin_urn?: string | null;
  post_text?: string | null;
  error_message?: string | null;
  created_at?: string;
  published_at?: string | null;
}

export function isAlreadyProcessed(contentHash: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT id FROM posts WHERE content_hash = ?")
    .get(contentHash) as { id: number } | undefined;
  return !!row;
}

export function savePost(record: Omit<PostRecord, "id" | "created_at">): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO posts
      (content_hash, title, source_url, score, status, linkedin_urn, post_text, error_message, published_at)
    VALUES
      (@content_hash, @title, @source_url, @score, @status, @linkedin_urn, @post_text, @error_message, @published_at)
  `);
  const result = stmt.run({
    ...record,
    linkedin_urn: record.linkedin_urn ?? null,
    post_text: record.post_text ?? null,
    error_message: record.error_message ?? null,
    published_at: record.status === "published" ? new Date().toISOString() : null,
  });
  return result.lastInsertRowid as number;
}

export function updatePostStatus(
  contentHash: string,
  status: PostRecord["status"],
  fields: Partial<Pick<PostRecord, "linkedin_urn" | "error_message">> = {}
): void {
  const db = getDb();
  db.prepare(`
    UPDATE posts
    SET status = ?, linkedin_urn = COALESCE(?, linkedin_urn), error_message = COALESCE(?, error_message),
        published_at = CASE WHEN ? = 'published' THEN datetime('now') ELSE published_at END
    WHERE content_hash = ?
  `).run(
    status,
    fields.linkedin_urn ?? null,
    fields.error_message ?? null,
    status,
    contentHash
  );
}

export function getRecentPosts(limit = 20): PostRecord[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM posts ORDER BY created_at DESC LIMIT ?")
    .all(limit) as PostRecord[];
}

// ─── Token records ────────────────────────────────────────────────────────────

export interface TokenRecord {
  access_token: string;
  refresh_token?: string | null;
  expires_at: string;
  scope?: string | null;
}

export function saveToken(token: TokenRecord): void {
  const db = getDb();
  // Solo guardamos un registro de token (upsert)
  db.prepare("DELETE FROM tokens").run();
  db.prepare(`
    INSERT INTO tokens (access_token, refresh_token, expires_at, scope, updated_at)
    VALUES (@access_token, @refresh_token, @expires_at, @scope, datetime('now'))
  `).run({
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? null,
    expires_at: token.expires_at,
    scope: token.scope ?? null,
  });
}

export function getStoredToken(): TokenRecord | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM tokens ORDER BY updated_at DESC LIMIT 1")
    .get() as TokenRecord | undefined;
  return row ?? null;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
