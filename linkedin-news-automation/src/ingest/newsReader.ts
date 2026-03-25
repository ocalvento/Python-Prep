import * as fs from "fs";
import * as crypto from "crypto";
import { z } from "zod";
import { config } from "../config";
import { logger } from "../config/logger";

// ─── Schema de validación ────────────────────────────────────────────────────

const NewsItemSchema = z.object({
  title: z.string().min(5, "El título debe tener al menos 5 caracteres"),
  summary: z.string().min(20, "El resumen debe tener al menos 20 caracteres"),
  url: z.string().url("La URL debe ser válida"),
  source: z.string().min(1, "La fuente es requerida"),
  published_at: z.string().refine((v) => !isNaN(Date.parse(v)), {
    message: "published_at debe ser una fecha válida (ISO 8601)",
  }),
  tags: z.array(z.string()).min(1, "Debe haber al menos 1 tag"),
});

const NewsFileSchema = z.array(NewsItemSchema);

export type NewsItem = z.infer<typeof NewsItemSchema>;

export interface IngestedNewsItem extends NewsItem {
  /** SHA-256 de title + url — usado para deduplicación */
  contentHash: string;
  /** Antigüedad en horas al momento de la ingesta */
  ageHours: number;
}

// ─── Funciones ────────────────────────────────────────────────────────────────

/**
 * Lee y valida el archivo news.json.
 * Filtra ítems inválidos con un warning en lugar de fallar.
 */
export function readNewsFile(filePath?: string): IngestedNewsItem[] {
  const targetPath = filePath ?? config.newsInputPath;

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
    throw new Error(`El archivo de noticias debe contener un array JSON`);
  }

  const validItems: IngestedNewsItem[] = [];
  const now = Date.now();

  for (let i = 0; i < raw.length; i++) {
    const result = NewsItemSchema.safeParse(raw[i]);
    if (!result.success) {
      logger.warn(`Item ${i} inválido, saltando`, {
        index: i,
        errors: result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`),
      });
      continue;
    }

    const item = result.data;
    const publishedMs = new Date(item.published_at).getTime();
    const ageHours = (now - publishedMs) / (1000 * 60 * 60);
    const contentHash = computeHash(item.title, item.url);

    validItems.push({ ...item, contentHash, ageHours });
  }

  logger.info(`Noticias ingestadas`, {
    total: raw.length,
    valid: validItems.length,
    invalid: raw.length - validItems.length,
  });

  return validItems;
}

export function computeHash(title: string, url: string): string {
  return crypto
    .createHash("sha256")
    .update(`${title}::${url}`)
    .digest("hex");
}
