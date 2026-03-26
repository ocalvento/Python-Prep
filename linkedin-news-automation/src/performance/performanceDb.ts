/**
 * performanceDb
 *
 * Raw SQLite layer for the post_performance table.
 * All functions return typed domain objects — no raw rows leak out.
 */

import { getDb } from "../db";
import { PostPerformance } from "./types";

// ─── Row shape (mirrors the table columns) ────────────────────────────────────

interface PerformanceRow {
  id: string;
  candidate_id: string;
  title: string;
  source_url: string;
  editorial_score: number;
  published_at: string;
  impressions: number;
  likes: number;
  comments: number;
  saves: number | null;
  engagement_rate: number;
  created_at: string;
  updated_at: string;
}

// ─── Writes ───────────────────────────────────────────────────────────────────

export function insertPerformance(record: {
  id: string;
  candidateId: string;
  title: string;
  sourceUrl: string;
  editorialScore: number;
  publishedAt: string;
}): void {
  getDb()
    .prepare(`
      INSERT INTO post_performance (
        id, candidate_id, title, source_url,
        editorial_score, published_at,
        impressions, likes, comments, saves, engagement_rate,
        created_at, updated_at
      ) VALUES (
        @id, @candidateId, @title, @sourceUrl,
        @editorialScore, @publishedAt,
        0, 0, 0, NULL, 0,
        datetime('now'), datetime('now')
      )
    `)
    .run(record);
}

/**
 * Overwrites all metric fields for a given post.
 * Returns true if the row existed and was updated.
 */
export function updatePerformanceRow(
  id: string,
  impressions: number,
  likes: number,
  comments: number,
  saves: number | null,
  engagementRate: number
): boolean {
  const result = getDb()
    .prepare(`
      UPDATE post_performance
      SET impressions     = @impressions,
          likes           = @likes,
          comments        = @comments,
          saves           = @saves,
          engagement_rate = @engagementRate,
          updated_at      = datetime('now')
      WHERE id = @id
    `)
    .run({ id, impressions, likes, comments, saves, engagementRate });
  return result.changes > 0;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export function selectById(id: string): PostPerformance | null {
  const row = getDb()
    .prepare("SELECT * FROM post_performance WHERE id = ?")
    .get(id) as PerformanceRow | undefined;
  return row ? toPostPerformance(row) : null;
}

export function selectTopByEngagement(limit: number): PostPerformance[] {
  const rows = getDb()
    .prepare(`
      SELECT * FROM post_performance
      ORDER BY engagement_rate DESC, impressions DESC
      LIMIT ?
    `)
    .all(limit) as PerformanceRow[];
  return rows.map(toPostPerformance);
}

/**
 * Returns the last N performance records joined with posts.score_breakdown.
 * Used exclusively by analyzePerformance().
 */
export function selectRecentWithBreakdown(limit: number): Array<{
  performance: PostPerformance;
  scoreBreakdown: Record<string, number> | null;
}> {
  const rows = getDb()
    .prepare(`
      SELECT pp.*, p.score_breakdown
      FROM post_performance pp
      LEFT JOIN posts p ON pp.candidate_id = p.boia_candidate_id
      ORDER BY pp.published_at DESC
      LIMIT ?
    `)
    .all(limit) as Array<PerformanceRow & { score_breakdown: string | null }>;

  return rows.map((row) => ({
    performance: toPostPerformance(row),
    scoreBreakdown: row.score_breakdown ? parseJson(row.score_breakdown) : null,
  }));
}

/** Count posts published since a given ISO datetime string. */
export function countPublishedSince(isoDatetime: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) as n FROM post_performance WHERE published_at >= ?")
    .get(isoDatetime) as { n: number };
  return row.n;
}

/** Returns editorial scores of posts published within the last N days. */
export function selectRecentEditorialScores(days: number): number[] {
  const rows = getDb()
    .prepare(`
      SELECT editorial_score
      FROM post_performance
      WHERE published_at >= datetime('now', @offset)
      ORDER BY published_at DESC
    `)
    .all({ offset: `-${days} days` }) as { editorial_score: number }[];
  return rows.map((r) => r.editorial_score);
}

// ─── Row → domain mapper ──────────────────────────────────────────────────────

function toPostPerformance(row: PerformanceRow): PostPerformance {
  return {
    id:            row.id,
    candidateId:   row.candidate_id,
    title:         row.title,
    sourceUrl:     row.source_url,
    editorialScore: row.editorial_score,
    publishedAt:   new Date(row.published_at),
    impressions:   row.impressions,
    likes:         row.likes,
    comments:      row.comments,
    saves:         row.saves ?? undefined,
    engagementRate: row.engagement_rate,
    createdAt:     new Date(row.created_at),
    updatedAt:     new Date(row.updated_at),
  };
}

function parseJson(s: string): Record<string, number> | null {
  try {
    return JSON.parse(s) as Record<string, number>;
  } catch {
    return null;
  }
}
