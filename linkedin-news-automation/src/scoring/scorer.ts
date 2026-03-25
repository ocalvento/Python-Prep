import { IngestedNewsItem } from "../ingest/newsReader";
import { logger } from "../config/logger";

// ─── Configuración de scoring ─────────────────────────────────────────────────

/**
 * Tags considerados de alta relevancia para publicaciones de tecnología / negocios.
 * Ajustar según el perfil del usuario.
 */
const HIGH_VALUE_TAGS = new Set([
  "ia", "inteligencia artificial", "ai", "machine learning", "ml",
  "tecnologia", "tecnología", "innovation", "innovación",
  "startup", "fintech", "saas", "cloud", "data", "datos",
  "liderazgo", "leadership", "management", "producto", "product",
  "emprendimiento", "venture", "growth",
]);

const MEDIUM_VALUE_TAGS = new Set([
  "negocios", "business", "marketing", "digital", "economia",
  "economía", "industria", "futuro", "tendencia", "trend",
  "sostenibilidad", "sustainability", "talento", "talent",
]);

/** Fuentes que merecen un bonus de confiabilidad */
const TRUSTED_SOURCES = new Set([
  "mit technology review", "harvard business review", "wired",
  "the economist", "techcrunch", "venturebeat", "bloomberg",
  "reuters", "bbc", "ft", "financial times", "infobae tecnología",
  "la nacion", "cronista", "el pais", "five thirty eight",
]);

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface ScoredNewsItem extends IngestedNewsItem {
  score: number;
  scoreBreakdown: ScoreBreakdown;
}

interface ScoreBreakdown {
  recency: number;
  tagRelevance: number;
  sourceCredibility: number;
  contentLength: number;
  bonus: number;
}

// ─── Scorer ───────────────────────────────────────────────────────────────────

/**
 * Asigna un score 0-100 basado en señales de relevancia.
 *
 * Distribución de puntos:
 *   Recencia        → hasta 30 pts  (exponencial: más reciente = más puntaje)
 *   Tags relevantes → hasta 35 pts
 *   Credibilidad    → hasta 20 pts
 *   Longitud copete → hasta 10 pts
 *   Bonus           →  hasta 5 pts  (título con pregunta, datos, %)
 */
export function scoreItem(item: IngestedNewsItem): ScoredNewsItem {
  const recency = scoreRecency(item.ageHours);
  const tagRelevance = scoreTagRelevance(item.tags);
  const sourceCredibility = scoreSourceCredibility(item.source);
  const contentLength = scoreContentLength(item.summary);
  const bonus = scoreBonus(item.title, item.summary);

  const rawScore = recency + tagRelevance + sourceCredibility + contentLength + bonus;
  const score = Math.min(100, Math.round(rawScore));

  const breakdown: ScoreBreakdown = {
    recency,
    tagRelevance,
    sourceCredibility,
    contentLength,
    bonus,
  };

  logger.debug("Score calculado", {
    title: item.title.substring(0, 60),
    score,
    breakdown,
  });

  return { ...item, score, scoreBreakdown: breakdown };
}

export function scoreItems(items: IngestedNewsItem[]): ScoredNewsItem[] {
  return items
    .map(scoreItem)
    .sort((a, b) => b.score - a.score);
}

// ─── Funciones auxiliares de scoring ─────────────────────────────────────────

function scoreRecency(ageHours: number): number {
  // Decaimiento exponencial: publicado hoy = 30 pts, 1 semana = ~5 pts
  if (ageHours < 0) return 0;
  const decay = Math.exp(-ageHours / 48); // half-life ≈ 33 hs
  return Math.round(decay * 30);
}

function scoreTagRelevance(tags: string[]): number {
  const normalizedTags = tags.map((t) => t.toLowerCase().trim());
  let points = 0;

  for (const tag of normalizedTags) {
    if (HIGH_VALUE_TAGS.has(tag)) {
      points += 10;
    } else if (MEDIUM_VALUE_TAGS.has(tag)) {
      points += 5;
    }
  }

  return Math.min(35, points);
}

function scoreSourceCredibility(source: string): number {
  const normalizedSource = source.toLowerCase().trim();

  if (TRUSTED_SOURCES.has(normalizedSource)) return 20;

  // Coincidencia parcial
  for (const trusted of TRUSTED_SOURCES) {
    if (normalizedSource.includes(trusted) || trusted.includes(normalizedSource)) {
      return 12;
    }
  }

  return 5; // fuente desconocida igual tiene algo de valor
}

function scoreContentLength(summary: string): number {
  const words = summary.split(/\s+/).length;
  if (words >= 80) return 10;
  if (words >= 50) return 7;
  if (words >= 30) return 5;
  if (words >= 15) return 3;
  return 1;
}

function scoreBonus(title: string, summary: string): number {
  const text = `${title} ${summary}`.toLowerCase();
  let bonus = 0;

  // Datos concretos aumentan credibilidad
  if (/\d+%/.test(text)) bonus += 2;
  if (/\$[\d,.]+/.test(text) || /usd|millones|billones/i.test(text)) bonus += 2;
  if (/estudio|informe|reporte|según|research/i.test(text)) bonus += 1;

  return Math.min(5, bonus);
}
