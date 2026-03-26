import * as fs from "fs";
import * as crypto from "crypto";
import { z } from "zod";
import { config } from "../config";
import { logger } from "../config/logger";

// ─── Parámetros de query a descartar en normalización de URL ─────────────────

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
  "fbclid", "gclid", "msclkid", "twclid", "ttclid",
  "ref", "referral", "source", "mc_cid", "mc_eid",
  "_ga", "igshid", "s_cid",
]);

// ─── Schema ───────────────────────────────────────────────────────────────────

const NewsItemSchema = z.object({
  title: z
    .string()
    .min(10, "El título debe tener al menos 10 caracteres")
    .max(300, "El título no puede superar 300 caracteres"),
  summary: z
    .string()
    .min(50, "El resumen debe tener al menos 50 caracteres")
    .max(5000, "El resumen no puede superar 5000 caracteres"),
  url: z.string().url("La URL debe ser válida"),
  canonical_url: z.string().url().optional(),
  source: z
    .string()
    .min(2, "La fuente es requerida")
    .max(100, "La fuente no puede superar 100 caracteres"),
  published_at: z
    .string()
    .refine((v) => {
      const d = Date.parse(v);
      return !isNaN(d);
    }, "published_at debe ser una fecha válida (ISO 8601)")
    .refine((v) => {
      const published = new Date(v);
      const now = new Date();
      const bufferMs = 2 * 60 * 60 * 1000; // 2 horas de margen para diferencias de timezone
      return published.getTime() <= now.getTime() + bufferMs;
    }, "published_at no puede ser una fecha futura")
    .refine((v) => {
      const published = new Date(v);
      const maxAgeMs = config.maxNewsAgeDays * 24 * 60 * 60 * 1000;
      return Date.now() - published.getTime() <= maxAgeMs;
    }, `published_at es demasiado antigua (máximo ${config.maxNewsAgeDays} días)`),
  tags: z
    .array(z.string().min(1).max(50))
    .min(1, "Debe haber al menos 1 tag")
    .max(20, "Máximo 20 tags"),
});

export type NewsItem = z.infer<typeof NewsItemSchema>;

export interface IngestedNewsItem extends NewsItem {
  /** SHA-256 del título normalizado + URL canónica sin tracking params */
  contentHash: string;
  /** Antigüedad en horas al momento de la ingesta */
  ageHours: number;
  /** URL normalizada (sin tracking params) */
  normalizedUrl: string;
}

// ─── Funciones públicas ───────────────────────────────────────────────────────

export function readNewsFile(filePath?: string): IngestedNewsItem[] {
  const targetPath = filePath ?? (config as Record<string, unknown>).newsInputPath as string ?? "./inputs/news.json";

  if (!fs.existsSync(targetPath)) {
    throw new Error(`Archivo de noticias no encontrado: ${targetPath}`);
  }

  let raw: unknown;
  try {
    const content = fs.readFileSync(targetPath, "utf-8");
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(`Error al parsear ${targetPath}: ${String(err)}`);
  }

  if (!Array.isArray(raw)) {
    throw new Error("El archivo de noticias debe contener un array JSON");
  }

  const validItems: IngestedNewsItem[] = [];
  const seenHashes = new Set<string>();
  const now = Date.now();

  for (let i = 0; i < raw.length; i++) {
    const result = NewsItemSchema.safeParse(raw[i]);

    if (!result.success) {
      logger.warn(`Item ${i} inválido, saltando`, {
        index: i,
        title: (raw[i] as Record<string, unknown>)?.title,
        errors: result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`),
      });
      continue;
    }

    const item = result.data;
    const normalized = normalizeItem(item);
    const publishedMs = new Date(item.published_at).getTime();
    const ageHours = (now - publishedMs) / (1000 * 60 * 60);
    const contentHash = computeHash(normalized.title, normalized.canonicalUrl);

    // Deduplicación dentro del mismo archivo de entrada
    if (seenHashes.has(contentHash)) {
      logger.warn(`Item ${i} duplicado dentro del archivo, saltando`, {
        title: item.title.substring(0, 60),
        hash: contentHash.substring(0, 12),
      });
      continue;
    }

    seenHashes.add(contentHash);
    validItems.push({
      ...item,
      title: normalized.title,
      summary: normalized.summary,
      source: normalized.source,
      tags: normalized.tags,
      contentHash,
      ageHours,
      normalizedUrl: normalized.canonicalUrl,
    });
  }

  logger.info("Noticias ingestadas", {
    total: raw.length,
    valid: validItems.length,
    invalid: raw.length - validItems.length,
    inFileDuplicates: raw.length - validItems.length - (raw.length - validItems.length),
  });

  return validItems;
}

export function computeHash(normalizedTitle: string, normalizedUrl: string): string {
  return crypto
    .createHash("sha256")
    .update(`${normalizedTitle}::${normalizedUrl}`)
    .digest("hex");
}

// ─── Normalización interna ────────────────────────────────────────────────────

interface NormalizedItem {
  title: string;
  summary: string;
  source: string;
  tags: string[];
  canonicalUrl: string;
}

function normalizeItem(item: NewsItem): NormalizedItem {
  return {
    title: normalizeText(item.title),
    summary: item.summary.trim().replace(/\s+/g, " "),
    source: normalizeText(item.source),
    tags: item.tags.map((t) => t.toLowerCase().trim()).filter(Boolean),
    canonicalUrl: normalizeUrl(item.canonical_url ?? item.url),
  };
}

/**
 * Normaliza texto para hashing consistente:
 * - Trim + colapsar espacios
 * - Lowercase
 * - Remover puntuación final redundante
 */
function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase().replace(/[.!?]+$/, "");
}

/**
 * Normaliza una URL eliminando parámetros de tracking y estandarizando el formato.
 * Esto evita que la misma noticia genere hashes distintos por diferentes UTMs.
 */
export function normalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);

    // Eliminar params de tracking
    for (const param of TRACKING_PARAMS) {
      url.searchParams.delete(param);
    }

    // Normalizar protocolo a https
    url.protocol = "https:";

    // Eliminar trailing slash en el path (excepto root)
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }

    // Eliminar el hash (fragmento)
    url.hash = "";

    return url.toString().toLowerCase();
  } catch {
    // Si la URL es inválida, devolver tal cual (la validación Zod ya la rechazó antes)
    return rawUrl.toLowerCase().trim();
  }
}
