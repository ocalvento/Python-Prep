import { ScoredNewsItem } from "../scoring/scorer";
import { logger } from "../config/logger";

const MAX_HASHTAGS = 4;
const MAX_POST_CHARS = 3000;

export interface GeneratedPost {
  text: string;
  hashtags: string[];
  charCount: number;
}

/**
 * Genera el texto del post de LinkedIn en español profesional.
 *
 * Estructura:
 *   Párrafo 1: Contexto y dato principal
 *   Párrafo 2: Implicancia / reflexión
 *   CTA suave + hashtags
 */
export function generatePost(item: ScoredNewsItem): GeneratedPost {
  const hashtags = buildHashtags(item.tags);
  const body = buildBody(item);
  const cta = buildCta(item);
  const hashtagLine = hashtags.join(" ");

  const text = [body, cta, hashtagLine].filter(Boolean).join("\n\n");

  if (text.length > MAX_POST_CHARS) {
    logger.warn("Post generado supera el límite de caracteres, truncando", {
      chars: text.length,
      limit: MAX_POST_CHARS,
    });
  }

  const finalText = text.substring(0, MAX_POST_CHARS);

  logger.debug("Post generado", {
    title: item.title.substring(0, 50),
    charCount: finalText.length,
    hashtags,
  });

  return {
    text: finalText,
    hashtags,
    charCount: finalText.length,
  };
}

// ─── Helpers privados ────────────────────────────────────────────────────────

function buildBody(item: ScoredNewsItem): string {
  const { title, summary, source, published_at } = item;

  // Extraer datos numéricos del summary para destacarlos
  const dataPoint = extractDataPoint(summary);

  let paragraph1: string;
  if (dataPoint) {
    paragraph1 = `${title}\n\n${dataPoint} Según ${source}, ${decapitalize(trimSentence(summary, 150))}`;
  } else {
    paragraph1 = `${title}\n\n${trimSentence(summary, 200)}`;
  }

  // Segundo párrafo: reflexión basada en los tags
  const reflection = buildReflection(item);

  return reflection ? `${paragraph1}\n\n${reflection}` : paragraph1;
}

function buildReflection(item: ScoredNewsItem): string {
  const tags = item.tags.map((t) => t.toLowerCase());

  if (hasAnyTag(tags, ["ia", "ai", "inteligencia artificial", "machine learning"])) {
    return "La velocidad a la que evoluciona este campo exige que tanto profesionales como organizaciones se mantengan actualizados y evalúen sus estrategias de adopción.";
  }
  if (hasAnyTag(tags, ["startup", "emprendimiento", "venture"])) {
    return "El ecosistema emprendedor sigue generando señales interesantes. Vale la pena estar atentos a cómo estos movimientos redefinen los mercados tradicionales.";
  }
  if (hasAnyTag(tags, ["liderazgo", "leadership", "management", "talento"])) {
    return "La manera en que lideramos equipos y organizaciones está en constante revisión. Estas perspectivas aportan valor para quienes buscan mejorar su práctica.";
  }
  if (hasAnyTag(tags, ["fintech", "economía", "economia", "negocios"])) {
    return "Los cambios en el entorno económico y financiero impactan directamente en las decisiones estratégicas de empresas y profesionales.";
  }
  if (hasAnyTag(tags, ["sostenibilidad", "sustainability"])) {
    return "La sostenibilidad dejó de ser una tendencia para convertirse en un requisito de competitividad y responsabilidad corporativa.";
  }

  return "";
}

function buildCta(item: ScoredNewsItem): string {
  const ctas = [
    `¿Te parece relevante para tu industria? Me interesa conocer tu perspectiva.`,
    `El artículo completo está disponible en ${item.source}. Vale la lectura.`,
    `¿Cómo está impactando esto en tu trabajo o sector?`,
    `Comparto el enlace para quien quiera profundizar en el tema.`,
  ];

  // Rotar CTA de forma determinista basada en el hash del item
  const index = parseInt(item.contentHash.substring(0, 4), 16) % ctas.length;
  return ctas[index];
}

function buildHashtags(tags: string[]): string[] {
  return tags
    .slice(0, MAX_HASHTAGS)
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

function extractDataPoint(text: string): string | null {
  const patterns = [
    /(\d+(?:[.,]\d+)?%[^.]*\.)/,
    /(\$[\d.,]+[^.]*(?:millones|billones|mil millones)[^.]*\.)/i,
    /(\d+(?:[.,]\d+)?(?:\s*(?:millones|mil millones))[^.]*\.)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function trimSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncated = text.substring(0, maxChars);
  const lastPeriod = truncated.lastIndexOf(".");
  return lastPeriod > maxChars * 0.6 ? truncated.substring(0, lastPeriod + 1) : truncated + "...";
}

function decapitalize(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function hasAnyTag(tags: string[], targets: string[]): boolean {
  return targets.some((t) => tags.includes(t));
}
