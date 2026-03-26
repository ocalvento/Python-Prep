/**
 * feedbackLoop
 *
 * Heuristic analysis of editorial score vs real engagement.
 * No ML libraries — pure statistics over the last 50 published posts.
 *
 * Two exported functions:
 *   analyzePerformance() → correlation report + weight adjustment hints
 *   shouldPublish()      → dynamic daily threshold (top-20% of last 30 days)
 */

import { PerformanceAnalysis, WeightAdjustment, PublishDecision } from "./types";
import {
  selectRecentWithBreakdown,
  countPublishedSince,
  selectRecentEditorialScores,
} from "./performanceDb";
import { config } from "../config";
import { logger } from "../config/logger";

// ─── Signal metadata (mirrors EditorialScoreBreakdown max values) ─────────────

const SIGNAL_MAX: Record<string, number> = {
  organismRelevance:     25,
  audienceImpact:        25,
  messageClarity:        15,
  recency:               15,
  conversationPotential: 10,
  dataBonus:             10,
  technicalityPenalty:   15, // stored as positive penalty — we negate it for correlation
};

// ─── analyzePerformance ───────────────────────────────────────────────────────

export function analyzePerformance(): PerformanceAnalysis {
  const records = selectRecentWithBreakdown(50);

  // Only posts that have real impression data are meaningful
  const withData = records.filter((r) => r.performance.impressions > 0);

  if (withData.length < 3) {
    logger.info("analyzePerformance: datos insuficientes para análisis", {
      totalRecords: records.length,
      withImpressions: withData.length,
    });
    return {
      correlation: 0,
      sampleSize: withData.length,
      insights: [
        `Datos insuficientes para análisis (${withData.length} posts con impresiones, se necesitan al menos 3)`,
      ],
      suggestedWeightAdjustments: [],
    };
  }

  const editorialScores = withData.map((r) => r.performance.editorialScore);
  const engagementRates  = withData.map((r) => r.performance.engagementRate);

  const correlation = pearsonCorrelation(editorialScores, engagementRates);
  const signalCorrs = computeSignalCorrelations(withData, engagementRates);
  const insights    = buildInsights(withData, correlation, signalCorrs);
  const adjustments = buildWeightAdjustments(signalCorrs);

  logger.info("Análisis de performance completado", {
    sampleSize: withData.length,
    correlation: round2(correlation),
  });

  return {
    correlation:                round2(correlation),
    sampleSize:                 withData.length,
    insights,
    suggestedWeightAdjustments: adjustments,
  };
}

// ─── shouldPublish ────────────────────────────────────────────────────────────

/**
 * Decides whether a candidate should be published based on:
 * 1. Daily rate limit (< maxPostsPerRun in the last recentWindowHours hours)
 * 2. Dynamic threshold: score must be in the top 20% of recent 30 days
 */
export function shouldPublish(
  score: number,
  recentWindowHours = 24
): PublishDecision {
  const windowStart = new Date(
    Date.now() - recentWindowHours * 60 * 60 * 1000
  ).toISOString();

  const publishedTodayCount = countPublishedSince(windowStart);

  if (publishedTodayCount >= config.maxPostsPerRun) {
    return {
      should: false,
      reason: `Ya se publicaron ${publishedTodayCount} posts en las últimas ${recentWindowHours}h (límite: ${config.maxPostsPerRun})`,
      threshold: 0,
      publishedTodayCount,
    };
  }

  const recentScores = selectRecentEditorialScores(30);
  const threshold    = computeTop20Threshold(recentScores);

  if (score < threshold) {
    return {
      should: false,
      reason: `Score ${score} está por debajo del umbral dinámico ${threshold} (top 20% de los últimos 30 días)`,
      threshold,
      publishedTodayCount,
    };
  }

  return {
    should: true,
    reason: `Score ${score} supera el umbral dinámico ${threshold}`,
    threshold,
    publishedTodayCount,
  };
}

// ─── Insight generation ───────────────────────────────────────────────────────

type RecordWithBreakdown = ReturnType<typeof selectRecentWithBreakdown>[number];

function buildInsights(
  records: RecordWithBreakdown[],
  correlation: number,
  signalCorrs: Record<string, number>
): string[] {
  const insights: string[] = [];

  // Overall correlation
  if (correlation > 0.4) {
    insights.push(
      `El score editorial predice bien el engagement (correlación: ${round2(correlation)}) — el modelo es consistente`
    );
  } else if (correlation < -0.1) {
    insights.push(
      `El score editorial NO correlaciona con engagement (${round2(correlation)}) — los criterios de scoring pueden necesitar revisión`
    );
  } else {
    insights.push(
      `Correlación moderada entre score editorial y engagement (${round2(correlation)}) — hay señales que no predicen comportamiento real`
    );
  }

  // High vs low scorers engagement comparison
  const sorted   = [...records].sort((a, b) => b.performance.editorialScore - a.performance.editorialScore);
  const mid      = Math.ceil(sorted.length / 2);
  const topHalf  = sorted.slice(0, mid);
  const btmHalf  = sorted.slice(mid);
  const avgTop   = mean(topHalf.map((r) => r.performance.engagementRate));
  const avgBtm   = mean(btmHalf.map((r) => r.performance.engagementRate));

  if (avgBtm > 0 && avgTop > avgBtm * 1.5) {
    const uplift = pct((avgTop / avgBtm) - 1);
    insights.push(
      `Posts con score alto tienen ${uplift} más engagement que los de score bajo — la señal de calidad funciona`
    );
  } else if (avgTop > 0 && avgBtm > avgTop * 1.2) {
    insights.push(
      `Posts con score bajo generan más engagement que los de score alto — posible sobreajuste del scoring editorial`
    );
  }

  // Per-signal insights (only when signal has > 0.1 absolute correlation)
  for (const [signal, corr] of Object.entries(signalCorrs)) {
    if (Math.abs(corr) < 0.15) continue;
    if (corr > 0.4) {
      insights.push(`"${signal}" correlaciona fuertemente con engagement (${round2(corr)}) — señal predictiva, considerar aumentar su peso`);
    } else if (corr < -0.3) {
      insights.push(`"${signal}" correlaciona negativamente con engagement (${round2(corr)}) — puede estar penalizando posts buenos`);
    }
  }

  // Recency special check: recent posts (recency ≥ 12) with strong engagement
  const recentHighEng = records.filter(
    (r) =>
      (r.scoreBreakdown?.recency ?? 0) >= 12 &&
      r.performance.engagementRate > 0.05
  ).length;
  const recencyRatio = recentHighEng / records.length;
  if (recencyRatio > 0.4) {
    insights.push(
      `La recencia correlaciona con engagement: el ${pct(recencyRatio)} de posts recientes tienen engagement > 5%`
    );
  }

  return insights;
}

// ─── Weight adjustments ───────────────────────────────────────────────────────

function buildWeightAdjustments(
  signalCorrs: Record<string, number>
): WeightAdjustment[] {
  return Object.entries(SIGNAL_MAX)
    .map(([signal, currentWeight]): WeightAdjustment | null => {
      const corr    = signalCorrs[signal] ?? 0;
      // suggested = current * (1 + corr * 0.5), clamped to [1, currentWeight * 1.5]
      const factor  = 1 + corr * 0.5;
      const raw     = Math.round(currentWeight * factor);
      const clamped = Math.max(1, Math.min(Math.round(currentWeight * 1.5), raw));

      // Only emit an adjustment if it's meaningfully different (≥ 2 pts)
      return Math.abs(clamped - currentWeight) >= 2
        ? { signal, currentWeight, suggestedWeight: clamped }
        : null;
    })
    .filter((a): a is WeightAdjustment => a !== null);
}

// ─── Signal correlation ───────────────────────────────────────────────────────

function computeSignalCorrelations(
  records: RecordWithBreakdown[],
  engagementRates: number[]
): Record<string, number> {
  const result: Record<string, number> = {};

  for (const signal of Object.keys(SIGNAL_MAX)) {
    const values = records.map((r) => {
      const raw = r.scoreBreakdown?.[signal] ?? 0;
      // Negate penalty so that "lower penalty = better" shows as positive correlation
      return signal === "technicalityPenalty" ? -raw : raw;
    });
    result[signal] = pearsonCorrelation(values, engagementRates);
  }

  return result;
}

// ─── Dynamic threshold ────────────────────────────────────────────────────────

/**
 * Returns the minimum score of the top 20% of recent posts.
 * Falls back to config.linkedinMinScore if no data exists.
 */
function computeTop20Threshold(scores: number[]): number {
  if (scores.length === 0) return config.linkedinMinScore;

  const sorted = [...scores].sort((a, b) => b - a);
  const top20  = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.2)));
  // The threshold is the lowest score still in the top 20%
  return top20[top20.length - 1];
}

// ─── Math utilities ───────────────────────────────────────────────────────────

function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;

  const mx = mean(xs);
  const my = mean(ys);

  let cov = 0;
  let varX = 0;
  let varY = 0;

  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov  += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  const denom = Math.sqrt(varX * varY);
  return denom === 0 ? 0 : cov / denom;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
