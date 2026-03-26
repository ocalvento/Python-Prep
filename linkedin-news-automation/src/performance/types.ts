import { z } from "zod";

// ─── Core domain type ─────────────────────────────────────────────────────────

export interface PostPerformance {
  id: string;
  candidateId: string;
  title: string;
  sourceUrl: string;
  editorialScore: number;
  publishedAt: Date;
  impressions: number;
  likes: number;
  comments: number;
  saves?: number;
  engagementRate: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Input validation ─────────────────────────────────────────────────────────

export const PostMetricsInputSchema = z.object({
  impressions: z.number().int().min(0, "impressions >= 0"),
  likes:       z.number().int().min(0, "likes >= 0"),
  comments:    z.number().int().min(0, "comments >= 0"),
  saves:       z.number().int().min(0).optional(),
});

export type PostMetricsInput = z.infer<typeof PostMetricsInputSchema>;

// ─── Feedback loop output ─────────────────────────────────────────────────────

export interface PerformanceAnalysis {
  /** Pearson r between editorialScore and engagementRate. Range [-1, 1]. */
  correlation: number;
  /** Number of posts with impressions > 0 used in the analysis. */
  sampleSize: number;
  insights: string[];
  suggestedWeightAdjustments: WeightAdjustment[];
}

export interface WeightAdjustment {
  signal: string;
  currentWeight: number;
  suggestedWeight: number;
}

// ─── shouldPublish output ─────────────────────────────────────────────────────

export interface PublishDecision {
  should: boolean;
  reason: string;
  /** Dynamic top-20% threshold, or 0 if rate-limited before reaching that check. */
  threshold: number;
  publishedTodayCount: number;
}
