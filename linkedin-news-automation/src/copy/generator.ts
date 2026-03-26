import { ScoredNewsItem } from "../scoring/scorer";
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

// ─── Banco de reflexiones por tema (múltiples variantes para evitar repetición) ─

const REFLECTIONS: Record<string, string[]> = {
  ia: [
    "La velocidad a la que evoluciona este campo exige que profesionales y organizaciones evalúen activamente sus estrategias de adopción.",
    "La brecha entre quienes adoptan estas herramientas y quienes las ignoran se hace más visible cada trimestre.",
    "El desafío ya no es solo técnico: es organizacional. Saber qué automatizar (y qué no) se vuelve una competencia estratégica.",
  ],
  startup: [
    "El ecosistema emprendedor sigue generando señales que vale la pena interpretar, más allá del ruido del ciclo de hype.",
    "Los movimientos en capital de riesgo anticipan tendencias que, generalmente, se materializan en los mercados tradicionales 18-24 meses después.",
    "Construir en condiciones de incertidumbre sigue siendo una de las habilidades más valiosas y menos formalizables del ecosistema.",
  ],
  liderazgo: [
    "La manera en que lideramos equipos está en revisión permanente. Estas perspectivas ayudan a calibrar la propia práctica.",
    "El liderazgo efectivo hoy requiere menos certezas y más capacidad de crear condiciones para que otros decidan bien.",
    "Los datos sobre equipos de alto rendimiento siguen apuntando en la misma dirección: autonomía + contexto claro + responsabilidad distribuida.",
  ],
  fintech: [
    "Los cambios en el entorno financiero impactan las decisiones estratégicas mucho antes de que aparezcan en los estados de resultados.",
    "La regulación y la tecnología financiera rara vez se mueven al mismo ritmo. Esa fricción es, a la vez, riesgo y oportunidad.",
    "La democratización del acceso financiero sigue siendo una de las transformaciones más subestimadas de la última década.",
  ],
  sostenibilidad: [
    "La sostenibilidad pasó de ser diferencial a ser requisito de entrada en muchas industrias. La pregunta ya no es si, sino cómo.",
    "Las empresas que integran criterios ESG en su core operativo están encontrando ventajas competitivas reales, no solo reputacionales.",
  ],
  cloud: [
    "La infraestructura como ventaja competitiva: las decisiones de arquitectura de hoy determinan la agilidad de los próximos años.",
    "La adopción cloud ya no es una pregunta de 'si' sino de 'qué modelo' y 'a qué velocidad'. La complejidad se desplazó.",
  ],
};

// ─── CTAs rotativos ───────────────────────────────────────────────────────────

const CTAS = [
  "¿Cómo está impactando esto en tu sector? Me interesa escuchar perspectivas.",
  "El artículo completo vale la lectura si el tema es relevante para tu trabajo.",
  "¿Lo estás viendo en tu industria también? Dejá tu perspectiva en los comentarios.",
  "Comparto el enlace para quien quiera profundizar.",
  "¿Qué ángulo de esto te parece más relevante para los próximos meses?",
];

// ─── Generación ───────────────────────────────────────────────────────────────

/**
 * Genera el texto del post y valida su calidad.
 * Devuelve { ok: false } si el copy no supera el umbral de calidad,
 * evitando publicar contenido débil o repetitivo.
 */
export function generatePost(
  item: ScoredNewsItem,
  recentPostTexts: string[] = []
): CopyResult {
  const hashtags = buildHashtags(item.tags);
  const body = buildBody(item);
  const reflection = buildReflection(item, recentPostTexts);
  const cta = buildCta(item);
  const hashtagLine = hashtags.join(" ");

  const parts = [body, reflection, cta, hashtagLine].filter(Boolean);
  const rawText = parts.join("\n\n");

  const maxChars = config.maxPostChars;
  const finalText = truncateToSentence(rawText, maxChars);

  if (rawText.length > maxChars) {
    logger.warn("Post truncado al límite de caracteres", {
      original: rawText.length,
      final: finalText.length,
    });
  }

  const qualityScore = assessQuality(finalText, item);

  logger.debug("Post generado", {
    title: item.title.substring(0, 50),
    charCount: finalText.length,
    qualityScore,
    hashtags,
  });

  // Validar calidad mínima
  if (finalText.length < config.copyMinChars) {
    const reason = `Copy demasiado corto: ${finalText.length} chars (mínimo ${config.copyMinChars})`;
    logger.warn("Copy rechazado: " + reason);
    return { ok: false, reason };
  }

  if (qualityScore < 40) {
    const reason = `Quality score insuficiente: ${qualityScore}/100`;
    logger.warn("Copy rechazado: " + reason, { title: item.title.substring(0, 60) });
    return { ok: false, reason };
  }

  // Detectar overlap excesivo con posts recientes
  if (recentPostTexts.length > 0) {
    const overlapRatio = computeMaxWordOverlap(finalText, recentPostTexts);
    if (overlapRatio > config.copyPhraseOverlapThreshold) {
      const reason = `Overlap con post reciente: ${Math.round(overlapRatio * 100)}% (máximo ${Math.round(config.copyPhraseOverlapThreshold * 100)}%)`;
      logger.warn("Copy rechazado: " + reason);
      return { ok: false, reason };
    }
  }

  return {
    ok: true,
    post: {
      text: finalText,
      hashtags,
      charCount: finalText.length,
      qualityScore,
    },
  };
}

// ─── Builders privados ────────────────────────────────────────────────────────

function buildBody(item: ScoredNewsItem): string {
  const dataPoint = extractDataPoint(item.summary);

  let paragraph1: string;
  if (dataPoint) {
    const rest = trimSentence(item.summary.replace(dataPoint, "").trim(), 180);
    paragraph1 = `${item.title}\n\n${dataPoint}${rest ? " " + decapitalize(rest) : ""}`;
  } else {
    paragraph1 = `${item.title}\n\n${trimSentence(item.summary, 220)}`;
  }

  return paragraph1;
}

function buildReflection(item: ScoredNewsItem, recentTexts: string[]): string {
  const tags = item.tags.map((t) => t.toLowerCase().trim());

  const topicKey = detectTopic(tags);
  if (!topicKey) return "";

  const variants = REFLECTIONS[topicKey];
  if (!variants || variants.length === 0) return "";

  // Elegir variante que tenga el menor overlap con posts recientes
  let bestVariant = variants[0];
  let lowestOverlap = Infinity;

  for (const variant of variants) {
    const overlap = recentTexts.length > 0
      ? computeMaxWordOverlap(variant, recentTexts)
      : 0;
    if (overlap < lowestOverlap) {
      lowestOverlap = overlap;
      bestVariant = variant;
    }
  }

  // Si todas las variantes tienen overlap alto, devolver vacío en lugar de repetir
  if (lowestOverlap > config.copyPhraseOverlapThreshold) {
    logger.debug("Todas las reflexiones tienen overlap alto, omitiendo", { topicKey });
    return "";
  }

  return bestVariant;
}

function buildCta(item: ScoredNewsItem): string {
  // Rotación determinista por hash del ítem para que sea reproducible
  const index = parseInt(item.contentHash.substring(0, 4), 16) % CTAS.length;
  return CTAS[index];
}

function buildHashtags(tags: string[]): string[] {
  return tags
    .slice(0, config.maxHashtags)
    .map((tag) =>
      "#" +
      tag
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
    .filter((h) => h.length > 1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectTopic(tags: string[]): string | null {
  if (tags.some((t) => ["ia", "ai", "inteligencia artificial", "machine learning", "llm"].includes(t))) return "ia";
  if (tags.some((t) => ["startup", "emprendimiento", "venture"].includes(t))) return "startup";
  if (tags.some((t) => ["liderazgo", "leadership", "management", "talento"].includes(t))) return "liderazgo";
  if (tags.some((t) => ["fintech", "economía", "economia", "negocios"].includes(t))) return "fintech";
  if (tags.some((t) => ["sostenibilidad", "sustainability"].includes(t))) return "sostenibilidad";
  if (tags.some((t) => ["cloud", "infraestructura"].includes(t))) return "cloud";
  return null;
}

function extractDataPoint(text: string): string | null {
  const patterns = [
    /(\d+(?:[.,]\d+)?%[^.]{0,60}\.)/,
    /(\$[\d.,]+[^.]{0,60}(?:millones|billones|mil millones)[^.]{0,30}\.)/i,
    /(\d+(?:[.,]\d+)?(?:\s*(?:millones|mil millones))[^.]{0,40}\.)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function trimSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncated = text.substring(0, maxChars);
  const lastPeriod = Math.max(truncated.lastIndexOf("."), truncated.lastIndexOf("?"), truncated.lastIndexOf("!"));
  return lastPeriod > maxChars * 0.6
    ? truncated.substring(0, lastPeriod + 1)
    : truncated.trimEnd() + "...";
}

function truncateToSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return trimSentence(text, maxChars);
}

function decapitalize(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Score de calidad del copy (0-100).
 * Factores: longitud, estructura, presencia del título, datos concretos.
 */
function assessQuality(text: string, item: ScoredNewsItem): number {
  let score = 0;

  // Longitud base
  if (text.length >= 300) score += 30;
  else if (text.length >= 200) score += 20;
  else if (text.length >= 100) score += 10;

  // Tiene al menos 2 párrafos
  if (text.includes("\n\n")) score += 20;

  // El título aparece en el post (no se perdió en el truncado)
  if (text.includes(item.title.substring(0, 30))) score += 15;

  // Tiene hashtags
  if (/#\w+/.test(text)) score += 10;

  // Tiene datos concretos (números, porcentajes)
  if (/\d+(?:[.,]\d+)?%|\$[\d.,]+|\d+ (?:millones|personas|empresas|países)/i.test(text)) {
    score += 15;
  }

  // Tiene CTA (signo de pregunta o llamado a acción)
  if (/[?¿]/.test(text) || /comparto|dejá|comentarios|perspectiva/i.test(text)) {
    score += 10;
  }

  return Math.min(100, score);
}

/**
 * Calcula el overlap máximo de palabras entre el nuevo texto y cualquiera de los recientes.
 * Usa coeficiente de Jaccard sobre bigramas para evitar falsos positivos de palabras cortas.
 */
function computeMaxWordOverlap(newText: string, recentTexts: string[]): number {
  const newBigrams = extractBigrams(newText);
  if (newBigrams.size === 0) return 0;

  let maxOverlap = 0;

  for (const recent of recentTexts) {
    const recentBigrams = extractBigrams(recent);
    if (recentBigrams.size === 0) continue;

    const intersection = new Set([...newBigrams].filter((b) => recentBigrams.has(b)));
    const union = new Set([...newBigrams, ...recentBigrams]);
    const jaccard = intersection.size / union.size;

    if (jaccard > maxOverlap) maxOverlap = jaccard;
  }

  return maxOverlap;
}

function extractBigrams(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-záéíóúüñ\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3); // ignorar palabras muy cortas

  const bigrams = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.add(`${words[i]}_${words[i + 1]}`);
  }
  return bigrams;
}
