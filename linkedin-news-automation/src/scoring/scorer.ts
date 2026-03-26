import { IngestedNewsItem } from "../ingest/newsReader";
import { config } from "../config";
import { logger } from "../config/logger";

// ─── Señales de relevancia ────────────────────────────────────────────────────

const HIGH_VALUE_TAGS = new Set([
  "ia", "inteligencia artificial", "ai", "machine learning", "ml", "llm",
  "tecnologia", "tecnología", "innovation", "innovación",
  "startup", "fintech", "saas", "cloud", "data", "datos",
  "liderazgo", "leadership", "management", "producto", "product",
  "emprendimiento", "venture", "growth", "automatizacion", "automatización",
]);

const MEDIUM_VALUE_TAGS = new Set([
  "negocios", "business", "marketing", "digital", "economia",
  "economía", "industria", "futuro", "tendencia", "trend",
  "sostenibilidad", "sustainability", "talento", "talent", "agile",
]);

const TRUSTED_SOURCES = new Set([
  "mit technology review", "harvard business review", "wired",
  "the economist", "techcrunch", "venturebeat", "bloomberg",
  "reuters", "bbc", "ft", "financial times", "infobae tecnología",
  "la nacion", "cronista", "el pais", "five thirty eight",
  "gartner", "mckinsey", "forrester", "idc",
]);

/** Frases genéricas que reducen el valor editorial del contenido */
const GENERIC_PHRASES = [
  "en el mundo actual", "en el mundo de hoy", "en la era digital",
  "es más importante que nunca", "el futuro es", "cada vez más",
  "sin lugar a dudas", "no hay duda de que", "es fundamental destacar",
  "vale la pena mencionar", "tips para mejorar", "consejos para",
  "todo lo que necesitas saber",
];

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface ScoreBreakdown {
  recency: number;
  tagRelevance: number;
  sourceCredibility: number;
  contentLength: number;
  bonus: number;
  penalty: number;
  /** Tags de alto valor encontrados */
  matchedHighTags: string[];
  /** Tags de valor medio encontrados */
  matchedMediumTags: string[];
}

export interface ScoredNewsItem extends IngestedNewsItem {
  score: number;
  scoreBreakdown: ScoreBreakdown;
}

// ─── Scorer público ───────────────────────────────────────────────────────────

export function scoreItem(item: IngestedNewsItem): ScoredNewsItem {
  const weights = {
    recency: config.scoreWeightRecency,
    tags: config.scoreWeightTags,
    source: config.scoreWeightSource,
    length: config.scoreWeightLength,
    bonus: config.scoreWeightBonus,
    penaltyMax: config.scorePenaltyMaxPoints,
  };

  const recency = scoreRecency(item.ageHours, weights.recency);
  const { points: tagRelevance, matchedHigh, matchedMedium } = scoreTagRelevance(item.tags, weights.tags);
  const sourceCredibility = scoreSourceCredibility(item.source, weights.source);
  const contentLength = scoreContentLength(item.summary, weights.length);
  const bonus = scoreBonus(item.title, item.summary, weights.bonus);
  const penalty = scorePenalty(item.title, item.summary, item.tags, weights.penaltyMax);

  const raw = recency + tagRelevance + sourceCredibility + contentLength + bonus - penalty;
  const score = Math.min(100, Math.max(0, Math.round(raw)));

  const breakdown: ScoreBreakdown = {
    recency,
    tagRelevance,
    sourceCredibility,
    contentLength,
    bonus,
    penalty,
    matchedHighTags: matchedHigh,
    matchedMediumTags: matchedMedium,
  };

  logger.debug("Score calculado", {
    title: item.title.substring(0, 60),
    score,
    breakdown: { recency, tagRelevance, sourceCredibility, contentLength, bonus, penalty },
  });

  return { ...item, score, scoreBreakdown: breakdown };
}

export function scoreItems(items: IngestedNewsItem[]): ScoredNewsItem[] {
  return items.map(scoreItem).sort((a, b) => b.score - a.score);
}

// ─── Señales ──────────────────────────────────────────────────────────────────

function scoreRecency(ageHours: number, maxPoints: number): number {
  if (ageHours < 0) return 0;
  // Half-life de 48h: publicado hace 2 días = 50% del puntaje máximo
  const decay = Math.exp(-ageHours / 48);
  return Math.round(decay * maxPoints);
}

function scoreTagRelevance(
  tags: string[],
  maxPoints: number
): { points: number; matchedHigh: string[]; matchedMedium: string[] } {
  const normalizedTags = tags.map((t) => t.toLowerCase().trim());
  const matchedHigh: string[] = [];
  const matchedMedium: string[] = [];

  for (const tag of normalizedTags) {
    if (HIGH_VALUE_TAGS.has(tag)) {
      matchedHigh.push(tag);
    } else if (MEDIUM_VALUE_TAGS.has(tag)) {
      matchedMedium.push(tag);
    }
  }

  // Puntaje por tag pero con retornos decrecientes: primer tag vale más
  const highPoints = matchedHigh.reduce((acc, _, i) => acc + Math.max(1, 10 - i * 2), 0);
  const mediumPoints = matchedMedium.reduce((acc, _, i) => acc + Math.max(1, 5 - i), 0);

  return {
    points: Math.min(maxPoints, highPoints + mediumPoints),
    matchedHigh,
    matchedMedium,
  };
}

function scoreSourceCredibility(source: string, maxPoints: number): number {
  const normalized = source.toLowerCase().trim();

  if (TRUSTED_SOURCES.has(normalized)) return maxPoints;

  for (const trusted of TRUSTED_SOURCES) {
    if (normalized.includes(trusted) || trusted.includes(normalized)) {
      return Math.round(maxPoints * 0.6);
    }
  }

  return Math.round(maxPoints * 0.25);
}

function scoreContentLength(summary: string, maxPoints: number): number {
  const words = summary.split(/\s+/).filter(Boolean).length;
  const ratio = Math.min(1, words / 80); // 80 palabras = máximo
  return Math.round(ratio * maxPoints);
}

function scoreBonus(title: string, summary: string, maxPoints: number): number {
  const text = `${title} ${summary}`.toLowerCase();
  let bonus = 0;

  // Datos concretos aumentan credibilidad
  if (/\d+(?:[.,]\d+)?%/.test(text)) bonus += 2;
  if (/\$[\d,.]+|\busd\b|millones|billones/i.test(text)) bonus += 2;
  if (/\bestudio\b|\binforme\b|\breporte\b|\bsegún\b|\bresearch\b/i.test(text)) bonus += 1;
  if (/\d{4}/.test(text)) bonus += 1; // Menciona un año concreto

  return Math.min(maxPoints, bonus);
}

/**
 * Penaliza contenido de baja calidad editorial.
 * Máximo penaltyMax puntos de penalización.
 */
function scorePenalty(
  title: string,
  summary: string,
  tags: string[],
  maxPenalty: number
): number {
  const text = `${title} ${summary}`.toLowerCase();
  let penalty = 0;

  // Penalizar frases genéricas
  for (const phrase of GENERIC_PHRASES) {
    if (text.includes(phrase)) {
      penalty += 3;
    }
  }

  // Penalizar resumen muy corto (menos de 30 palabras)
  const wordCount = summary.split(/\s+/).filter(Boolean).length;
  if (wordCount < 30) {
    penalty += Math.round((30 - wordCount) / 3); // hasta ~10 puntos extra
  }

  // Penalizar si solo tiene tags genéricos (ninguno en HIGH ni MEDIUM)
  const normalizedTags = tags.map((t) => t.toLowerCase().trim());
  const hasRelevantTag = normalizedTags.some(
    (t) => HIGH_VALUE_TAGS.has(t) || MEDIUM_VALUE_TAGS.has(t)
  );
  if (!hasRelevantTag) {
    penalty += 5;
  }

  // Penalizar título demasiado corto (menos de 4 palabras)
  if (title.split(/\s+/).length < 4) {
    penalty += 4;
  }

  return Math.min(maxPenalty, penalty);
}
