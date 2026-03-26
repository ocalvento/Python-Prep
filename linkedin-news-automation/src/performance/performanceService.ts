/**
 * performanceService
 *
 * Public API for the performance tracking module.
 * Handles business logic; delegates persistence to performanceDb.
 */

import * as crypto from "crypto";
import { PostPerformance, PostMetricsInput } from "./types";
import {
  insertPerformance,
  updatePerformanceRow,
  selectTopByEngagement,
  selectById,
} from "./performanceDb";
import { logger } from "../config/logger";

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Called right after a post is published.
 * Creates an initial performance record with all metrics at zero.
 */
export function createPostPerformance(
  candidateId: string,
  title: string,
  sourceUrl: string,
  editorialScore: number,
  publishedAt: Date = new Date()
): PostPerformance {
  const id = crypto.randomUUID();
  const publishedAtStr = publishedAt.toISOString();

  insertPerformance({ id, candidateId, title, sourceUrl, editorialScore, publishedAt: publishedAtStr });

  logger.info("Performance record creado", { id, candidateId, editorialScore });

  return {
    id,
    candidateId,
    title,
    sourceUrl,
    editorialScore,
    publishedAt,
    impressions: 0,
    likes: 0,
    comments: 0,
    saves: undefined,
    engagementRate: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Updates engagement metrics for an existing performance record.
 * Recalculates engagementRate = (likes + comments*2) / impressions.
 * Returns null if the postId does not exist.
 */
export function updatePostMetrics(
  postId: string,
  metrics: PostMetricsInput
): PostPerformance | null {
  const engagementRate = computeEngagementRate(
    metrics.impressions,
    metrics.likes,
    metrics.comments
  );

  const updated = updatePerformanceRow(
    postId,
    metrics.impressions,
    metrics.likes,
    metrics.comments,
    metrics.saves ?? null,
    engagementRate
  );

  if (!updated) {
    logger.warn("updatePostMetrics: post no encontrado", { postId });
    return null;
  }

  logger.info("Métricas de performance actualizadas", {
    postId,
    impressions: metrics.impressions,
    likes: metrics.likes,
    comments: metrics.comments,
    engagementRate: round4(engagementRate),
  });

  return selectById(postId);
}

/** Returns top N posts sorted by engagement_rate DESC. */
export function getTopPerformingPosts(limit = 10): PostPerformance[] {
  return selectTopByEngagement(limit);
}

// ─── Pure utility ─────────────────────────────────────────────────────────────

/**
 * engagement_rate = (likes + comments*2) / impressions
 *
 * Comments are weighted 2× because they signal deeper engagement than a passive like.
 * Safe against division by zero.
 */
export function computeEngagementRate(
  impressions: number,
  likes: number,
  comments: number
): number {
  if (impressions <= 0) return 0;
  return (likes + comments * 2) / impressions;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
