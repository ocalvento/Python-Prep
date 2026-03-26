/**
 * editorialScorer
 *
 * Calcula el LinkedIn Publish Score (0-100) para candidatos de BOIA.
 * El score determina si un ítem regulatorio merece publicación pública en LinkedIn.
 *
 * Señales positivas:
 *   organismRelevance    → 0-25  organismo emisor relevante para audiencia fintech/legal
 *   audienceImpact       → 0-25  overlap entre affectedAudience y audiencia target LinkedIn
 *   messageClarity       → 0-15  calidad del whyItMatters como base de post
 *   recency              → 0-15  decaimiento exponencial (half-life 36h)
 *   conversationPotential→ 0-10  potencial de engagement y discusión
 *   dataBonus            → 0-10  datos concretos, deadlines, linkedinAngle provisto
 *
 * Penalizaciones:
 *   technicalityPenalty  → 0-15  lenguaje excesivamente técnico, solo referencias legales
 *   redundancyPenalty    → 0-10  calculada externamente por el pipeline (mismo organismo)
 */

import { BoiaCandidate } from "../ingest/types";
import { config } from "../config";
import { logger } from "../config/logger";

// ─── Organismos conocidos ─────────────────────────────────────────────────────

const HIGH_IMPACT_ORGANISMS = new Set([
  // Argentina
  "bcra", "banco central", "banco central de la república argentina",
  "cnv", "comisión nacional de valores",
  "uif", "unidad de información financiera",
  // Internacional sistémico
  "sec", "securities and exchange commission",
  "fed", "federal reserve",
  "bce", "banco central europeo",
  "bis", "bank for international settlements",
  "eba", "european banking authority",
  "fsb", "financial stability board",
  "fatf", "gafi",
]);

const MEDIUM_IMPACT_ORGANISMS = new Set([
  // Argentina
  "afip", "arca", "administración federal de ingresos públicos",
  "ministerio de economía", "mecon", "secretaría de finanzas",
  "ssn", "superintendencia de seguros",
  "cnrt", "superintendencia de servicios de salud",
  "indec",
  // LATAM
  "banxico", "banco de méxico",
  "cmf", "comisión para el mercado financiero",  // Chile
  "sbif",
  "asfi",  // Bolivia
  "sbs",   // Perú
  "superfinanciera",  // Colombia
  "cnh",   // México crypto
]);

// ─── Audiencia target de LinkedIn ─────────────────────────────────────────────

const LINKEDIN_TARGET_AUDIENCE = new Set([
  "bancos", "banco", "entidades financieras", "entidades de crédito",
  "fintechs", "fintech", "psp", "proveedores de servicios de pago",
  "compliance", "oficial de cumplimiento", "cumplimiento normativo",
  "legal", "área legal", "abogados",
  "regulatorio", "regulación",
  "producto", "product managers", "product owner",
  "cfo", "tesorería", "finanzas corporativas",
  "auditores", "auditoría interna", "riesgo",
  "startups", "emprendedores",
  "inversores", "venture capital",
  "criptomonedas", "cripto", "activos digitales", "defi",
  "seguros",
]);

// ─── Señales de potencial de conversación ─────────────────────────────────────

const CONVERSATION_TAGS = new Set([
  "regulación", "regulatorio", "compliance", "fintech", "crypto", "cripto",
  "ia", "inteligencia artificial", "open finance", "open banking",
  "pagos", "psp", "cbdc", "stablecoin", "defi", "tokenización",
  "lavado de dinero", "uif", "kyc", "aml",
]);

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface EditorialScoreBreakdown {
  organismRelevance: number;
  audienceImpact: number;
  messageClarity: number;
  recency: number;
  conversationPotential: number;
  dataBonus: number;
  technicalityPenalty: number;
  /** Organismos que coinciden con la audiencia target */
  matchedAudience: string[];
}

export interface ScoredBoiaCandidate extends BoiaCandidate {
  linkedinPublishScore: number;
  scoreBreakdown: EditorialScoreBreakdown;
}

// ─── Scorer público ───────────────────────────────────────────────────────────

export function scoreCandidate(candidate: BoiaCandidate): ScoredBoiaCandidate {
  const organismRelevance = scoreOrganismRelevance(candidate.organism);
  const { points: audienceImpact, matched: matchedAudience } = scoreAudienceImpact(
    candidate.affectedAudience
  );
  const messageClarity = scoreMessageClarity(candidate.whyItMatters, candidate.summary);
  const recency = scoreRecency(candidate.ageHours);
  const conversationPotential = scoreConversationPotential(candidate.tags, candidate.category);
  const dataBonus = scoreDataBonus(
    candidate.summary,
    candidate.whyItMatters,
    candidate.linkedinAngle
  );
  const technicalityPenalty = scoreTechnicalityPenalty(
    candidate.summary,
    candidate.whyItMatters
  );

  const raw =
    organismRelevance +
    audienceImpact +
    messageClarity +
    recency +
    conversationPotential +
    dataBonus -
    technicalityPenalty;

  const linkedinPublishScore = Math.min(100, Math.max(0, Math.round(raw)));

  const breakdown: EditorialScoreBreakdown = {
    organismRelevance,
    audienceImpact,
    messageClarity,
    recency,
    conversationPotential,
    dataBonus,
    technicalityPenalty,
    matchedAudience,
  };

  logger.debug("LinkedIn publish score calculado", {
    id: candidate.id,
    title: candidate.title.substring(0, 60),
    linkedinPublishScore,
    boiaRelevanceScore: candidate.boiaRelevanceScore,
    breakdown: { organismRelevance, audienceImpact, messageClarity, recency, conversationPotential, dataBonus, technicalityPenalty },
  });

  return { ...candidate, linkedinPublishScore, scoreBreakdown: breakdown };
}

export function scoreCandidates(candidates: BoiaCandidate[]): ScoredBoiaCandidate[] {
  return candidates
    .map(scoreCandidate)
    .sort((a, b) => b.linkedinPublishScore - a.linkedinPublishScore);
}

// ─── Señales ──────────────────────────────────────────────────────────────────

function scoreOrganismRelevance(organism: string): number {
  const normalized = organism.toLowerCase().trim();

  if (HIGH_IMPACT_ORGANISMS.has(normalized)) return 25;

  // Coincidencia parcial para nombres largos (ej. "BCRA — Comunicación A")
  for (const known of HIGH_IMPACT_ORGANISMS) {
    if (normalized.includes(known) || known.includes(normalized)) return 20;
  }

  if (MEDIUM_IMPACT_ORGANISMS.has(normalized)) return 15;

  for (const known of MEDIUM_IMPACT_ORGANISMS) {
    if (normalized.includes(known) || known.includes(normalized)) return 10;
  }

  return 5; // organismo desconocido pero BOIA lo incluyó = alguna relevancia
}

function scoreAudienceImpact(
  affectedAudience: string[]
): { points: number; matched: string[] } {
  const matched: string[] = [];

  for (const audience of affectedAudience) {
    const norm = audience.toLowerCase().trim();
    if (LINKEDIN_TARGET_AUDIENCE.has(norm)) {
      matched.push(norm);
    } else {
      // Coincidencia parcial
      for (const target of LINKEDIN_TARGET_AUDIENCE) {
        if (norm.includes(target) || target.includes(norm)) {
          matched.push(norm);
          break;
        }
      }
    }
  }

  // 5 pts por audiencia, con retornos decrecientes, máx 25
  const points = matched.reduce((acc, _, i) => acc + Math.max(1, 7 - i * 2), 0);
  return { points: Math.min(25, points), matched };
}

function scoreMessageClarity(whyItMatters: string, summary: string): number {
  let score = 0;

  // Longitud del whyItMatters: más contexto = más claro
  const wtmWords = whyItMatters.split(/\s+/).filter(Boolean).length;
  if (wtmWords >= 60) score += 8;
  else if (wtmWords >= 30) score += 5;
  else if (wtmWords >= 15) score += 3;

  // Tiene lenguaje orientado a impacto concreto
  const impactPhrases = [
    /\bdeberán?\b/i, /\btendrán? que\b/i, /\bobligan?\b/i, /\bexige?n?\b/i,
    /\bimpacta\b/i, /\bafecta\b/i, /\bcambia\b/i, /\bnuevo requisito\b/i,
    /\bplazo\b/i, /\bfecha límite\b/i, /\ba partir de\b/i,
  ];
  const combined = `${whyItMatters} ${summary}`;
  const impactCount = impactPhrases.filter((p) => p.test(combined)).length;
  score += Math.min(5, impactCount * 1.5);

  // Summary suficientemente largo
  const summaryWords = summary.split(/\s+/).filter(Boolean).length;
  if (summaryWords >= 80) score += 2;

  return Math.min(15, score);
}

function scoreRecency(ageHours: number): number {
  if (ageHours < 0) return 0;
  // Half-life de 36h (noticias regulatorias tienen vida útil algo más larga)
  const decay = Math.exp(-ageHours / 52);
  return Math.round(decay * 15);
}

function scoreConversationPotential(tags: string[], category: string): number {
  let score = 0;

  const allTerms = [...tags, category.toLowerCase()];
  for (const term of allTerms) {
    if (CONVERSATION_TAGS.has(term.toLowerCase().trim())) {
      score += 3;
    }
  }

  return Math.min(10, score);
}

function scoreDataBonus(summary: string, whyItMatters: string, linkedinAngle?: string): number {
  const combined = `${summary} ${whyItMatters}`.toLowerCase();
  let bonus = 0;

  // Datos numéricos concretos
  if (/\d+(?:[.,]\d+)?%/.test(combined)) bonus += 2;
  if (/\$[\d,.]+|usd\s*\d|\d+\s*(?:millones|billones)/i.test(combined)) bonus += 2;

  // Fecha o plazo explícito
  if (/\bplazo\b|fecha límite|a partir del?|desde el?\s+\d/i.test(combined)) bonus += 2;

  // Número de artículo/comunicación (existe pero no es lo único)
  if (/com[\.un]?\s*a?\s*\d|res[\.oluci]+\s*\d|art[íi]culo\s+\d/i.test(combined)) bonus += 1;

  // linkedin_angle provisto por BOIA = señal fuerte de publicabilidad
  if (linkedinAngle && linkedinAngle.trim().length > 20) bonus += 3;

  return Math.min(10, bonus);
}

/**
 * Penaliza contenido demasiado técnico para LinkedIn.
 * No penaliza tener referencias legales, sino no tener explicación en lenguaje llano.
 */
function scoreTechnicalityPenalty(summary: string, whyItMatters: string): number {
  const combined = `${summary} ${whyItMatters}`;
  let penalty = 0;

  // Demasiadas referencias legales sin contexto de impacto
  const legalRefs = (combined.match(/art[íi]culo\s+\d|com[\.un]?\s*a?\s*\d|res[\.oluci]+\s+n[°o]?\s*\d|anexo\s+[ivxlc]+/gi) ?? []).length;
  if (legalRefs >= 5) penalty += 5;
  else if (legalRefs >= 3) penalty += 3;

  // Solo siglas sin explicación en whyItMatters (señal de tecnicismo)
  const siglaCount = (whyItMatters.match(/\b[A-Z]{2,5}\b/g) ?? []).length;
  const whyWords = whyItMatters.split(/\s+/).length;
  if (siglaCount > 0 && siglaCount / whyWords > 0.15) {
    penalty += 4; // demasiada densidad de siglas
  }

  // whyItMatters muy corto = no fue bien explicado
  if (whyItMatters.split(/\s+/).filter(Boolean).length < 20) {
    penalty += 6;
  }

  return Math.min(config.scorePenaltyMaxPoints, penalty);
}
