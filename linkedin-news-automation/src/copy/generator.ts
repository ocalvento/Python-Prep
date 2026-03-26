/**
 * Generador de copy para LinkedIn orientado a contenido regulatorio de BOIA.
 *
 * Principios editoriales:
 * - Traducir la novedad regulatoria a impacto práctico, no copiar el resumen
 * - Empezar por el "por qué importa", no por la norma en sí
 * - Mencionar el organismo y la norma brevemente (1 vez), sin reproducir artículos
 * - Tono profesional, claro, concreto — orientado a regulación + negocio
 * - No inventar efectos jurídicos que BOIA no haya explicitado
 * - CTA que invite a discusión, no a clickear
 */

import { ScoredBoiaCandidate } from "../scoring/editorialScorer";
import { config } from "../config";
import { logger } from "../config/logger";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface GeneratedPost {
  text: string;
  hashtags: string[];
  charCount: number;
  qualityScore: number;
}

export type CopyResult =
  | { ok: true; post: GeneratedPost }
  | { ok: false; reason: string };

// ─── Templates de apertura por tipo de acción regulatoria ────────────────────

const OPENING_HOOKS: Record<string, string[]> = {
  nuevorequisito: [
    "Nuevo requisito en vigencia:",
    "Cambio normativo que impacta la operación:",
    "El marco regulatorio actualiza sus exigencias:",
  ],
  plazo: [
    "Hay un plazo que vence y conviene tener en el radar:",
    "Fecha límite en el horizonte:",
    "El reloj corre:",
  ],
  sancion: [
    "Precedente regulatorio relevante:",
    "Caso de enforcement que marca el tono:",
    "La autoridad envía una señal clara:",
  ],
  consulta: [
    "Oportunidad para influir en la regulación:",
    "El regulador abre el debate:",
    "Se abre el período de consulta pública:",
  ],
  comunicacion: [
    "Nueva comunicación oficial:",
    "El regulador actualiza su posición:",
    "Novedades desde el organismo:",
  ],
};

// ─── CTAs rotativos ───────────────────────────────────────────────────────────

const CTAS = [
  "¿Cómo lo están procesando en sus organizaciones? Me interesa la perspectiva de quienes estén en compliance o producto.",
  "¿Ya lo tienen en el radar? Para quienes trabajan en banca o fintech, vale la revisión.",
  "¿Tienen identificado el impacto en sus procesos? Interesante leerlos en comentarios.",
  "El debate sobre cómo implementar esto recién empieza. ¿Qué perspectiva tienen desde sus equipos?",
  "Para quienes lo estén analizando: ¿cuál es el mayor desafío operativo que ven?",
];

// ─── Generación ───────────────────────────────────────────────────────────────

export function generatePost(
  candidate: ScoredBoiaCandidate,
  recentPostTexts: string[] = []
): CopyResult {
  const hook = buildHook(candidate);
  const body = buildBody(candidate);
  const audienceLine = buildAudienceLine(candidate);
  const cta = buildCta(candidate);
  const hashtags = buildHashtags(candidate);
  const hashtagLine = hashtags.join(" ");

  const parts = [hook, body, audienceLine, cta, hashtagLine].filter(Boolean);
  const rawText = parts.join("\n\n");

  const maxChars = config.maxPostChars;
  const finalText = truncateGracefully(rawText, maxChars);

  if (rawText.length > maxChars) {
    logger.warn("Post truncado al límite de caracteres", {
      original: rawText.length,
      final: finalText.length,
    });
  }

  const qualityScore = assessQuality(finalText, candidate);

  logger.debug("Post generado para candidato BOIA", {
    id: candidate.id,
    charCount: finalText.length,
    qualityScore,
    hashtags,
  });

  // ── Validaciones de calidad ───────────────────────────────────────────────

  if (finalText.length < config.copyMinChars) {
    const reason = `Copy demasiado corto: ${finalText.length} chars (mínimo ${config.copyMinChars})`;
    logger.warn("Copy rechazado: " + reason);
    return { ok: false, reason };
  }

  if (qualityScore < 40) {
    const reason = `Quality score insuficiente: ${qualityScore}/100`;
    logger.warn("Copy rechazado: " + reason, { id: candidate.id });
    return { ok: false, reason };
  }

  if (recentPostTexts.length > 0) {
    const overlap = computeMaxBigramOverlap(finalText, recentPostTexts);
    if (overlap > config.copyPhraseOverlapThreshold) {
      const reason = `Overlap con post reciente: ${Math.round(overlap * 100)}% > ${Math.round(config.copyPhraseOverlapThreshold * 100)}%`;
      logger.warn("Copy rechazado: " + reason);
      return { ok: false, reason };
    }
  }

  return {
    ok: true,
    post: { text: finalText, hashtags, charCount: finalText.length, qualityScore },
  };
}

// ─── Builders ────────────────────────────────────────────────────────────────

function buildHook(candidate: ScoredBoiaCandidate): string {
  // Detectar tipo de acción desde el título o categoría
  const combined = `${candidate.title} ${candidate.category}`.toLowerCase();
  let hookType = "comunicacion";

  if (/plazo|venc|fecha|días?/.test(combined)) hookType = "plazo";
  else if (/sanción|sancionó|multó|infracción/.test(combined)) hookType = "sancion";
  else if (/consulta pública|período de consulta/.test(combined)) hookType = "consulta";
  else if (/nuevo requisito|nueva exigencia|establece|incorpora|modifica/.test(combined)) hookType = "nuevorequisito";

  const variants = OPENING_HOOKS[hookType] ?? OPENING_HOOKS["comunicacion"];
  const idx = parseInt(candidate.contentHash.substring(0, 2), 16) % variants.length;
  const hook = variants[idx];

  // Agregar el título de la noticia bajo el hook
  return `${hook}\n${candidate.title}`;
}

function buildBody(candidate: ScoredBoiaCandidate): string {
  // Si BOIA proveyó un ángulo editorial, usarlo como base del cuerpo
  if (candidate.linkedinAngle && candidate.linkedinAngle.trim().length > 30) {
    return translateToPlainLanguage(candidate.linkedinAngle, candidate);
  }

  // Si no, construir desde whyItMatters
  return translateToPlainLanguage(candidate.whyItMatters, candidate);
}

/**
 * Transforma texto técnico de BOIA en lenguaje de LinkedIn.
 * No inventa datos: solo reformula lo que ya está en el texto.
 */
function translateToPlainLanguage(text: string, candidate: ScoredBoiaCandidate): string {
  // Extraer datos numéricos para preservarlos
  const dataPoints = extractDataPoints(text);

  // Tomar las primeras 2-3 oraciones del texto, reformuladas
  const sentences = text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim().length > 20)
    .slice(0, 3);

  let body = sentences.join(" ").trim();

  // Si hay datos extraídos, verificar que estén en el cuerpo
  if (dataPoints.length > 0 && !dataPoints.some((d) => body.includes(d))) {
    body = `${dataPoints[0]} ${body}`;
  }

  // Agregar referencia al organismo de forma natural (1 vez)
  if (!body.toLowerCase().includes(candidate.organism.toLowerCase())) {
    body = `Según ${candidate.organism}, ${decapitalize(body)}`;
  }

  return trimToSentence(body, 400);
}

function buildAudienceLine(candidate: ScoredBoiaCandidate): string {
  if (candidate.affectedAudience.length === 0) return "";

  const audience = candidate.affectedAudience
    .slice(0, 3)
    .map((a) => a.toLowerCase())
    .join(", ");

  return `Aplica especialmente a: ${audience}.`;
}

function buildCta(candidate: ScoredBoiaCandidate): string {
  const idx = parseInt(candidate.contentHash.substring(2, 4), 16) % CTAS.length;
  return CTAS[idx];
}

function buildHashtags(candidate: ScoredBoiaCandidate): string[] {
  const candidates: string[] = [
    candidate.organism,
    candidate.category,
    ...candidate.tags,
    ...candidate.affectedAudience.slice(0, 2),
  ];

  return candidates
    .map((t) =>
      "#" +
      t
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/[áàâä]/g, "a")
        .replace(/[éèêë]/g, "e")
        .replace(/[íìîï]/g, "i")
        .replace(/[óòôö]/g, "o")
        .replace(/[úùûü]/g, "u")
        .replace(/ñ/g, "n")
        .replace(/[^a-z0-9]/g, "")
    )
    .filter((h) => h.length > 2)
    .filter((h, i, arr) => arr.indexOf(h) === i) // dedup
    .slice(0, config.maxHashtags);
}

// ─── Quality assessment ───────────────────────────────────────────────────────

function assessQuality(text: string, candidate: ScoredBoiaCandidate): number {
  let score = 0;

  // Longitud
  if (text.length >= 400) score += 25;
  else if (text.length >= 250) score += 15;
  else if (text.length >= 150) score += 8;

  // Estructura: al menos 2 párrafos
  if (text.includes("\n\n")) score += 15;

  // Menciona el organismo
  if (text.toLowerCase().includes(candidate.organism.toLowerCase().substring(0, 4))) score += 10;

  // Tiene datos concretos
  if (/\d+(?:[.,]\d+)?%|\$[\d,.]+|\d+ (?:días|meses|empresas|entidades)/i.test(text)) score += 15;

  // Tiene hashtags
  if (/#\w+/.test(text)) score += 10;

  // Tiene CTA (pregunta o llamado)
  if (/[?¿]/.test(text) || /comentarios|perspectiva|radar|equipos/i.test(text)) score += 15;

  // No copia literalmente el summary (señal de que fue transformado)
  const summaryStart = candidate.summary.substring(0, 50).toLowerCase();
  if (!text.toLowerCase().includes(summaryStart)) score += 10;

  return Math.min(100, score);
}

// ─── Overlap de bigramas ──────────────────────────────────────────────────────

function computeMaxBigramOverlap(newText: string, recentTexts: string[]): number {
  const newBigrams = extractBigrams(newText);
  if (newBigrams.size === 0) return 0;

  let max = 0;
  for (const recent of recentTexts) {
    const recentBigrams = extractBigrams(recent);
    if (recentBigrams.size === 0) continue;
    const intersection = [...newBigrams].filter((b) => recentBigrams.has(b)).length;
    const union = new Set([...newBigrams, ...recentBigrams]).size;
    const jaccard = intersection / union;
    if (jaccard > max) max = jaccard;
  }
  return max;
}

function extractBigrams(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-záéíóúüñ\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const bigrams = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.add(`${words[i]}_${words[i + 1]}`);
  }
  return bigrams;
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

function extractDataPoints(text: string): string[] {
  const patterns = [
    /\d+(?:[.,]\d+)?%[^.]{0,60}\./,
    /\$[\d.,]+[^.]{0,60}(?:millones|billones|mil millones)[^.]{0,30}\./i,
    /\d+ (?:días|meses|años)[^.]{0,40}\./i,
  ];
  const found: string[] = [];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) found.push(m[0].trim());
  }
  return found;
}

function trimToSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncated = text.substring(0, maxChars);
  const last = Math.max(
    truncated.lastIndexOf("."),
    truncated.lastIndexOf("?"),
    truncated.lastIndexOf("!")
  );
  return last > maxChars * 0.6 ? truncated.substring(0, last + 1) : truncated.trimEnd() + "...";
}

function truncateGracefully(text: string, maxChars: number): string {
  return trimToSentence(text, maxChars);
}

function decapitalize(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
