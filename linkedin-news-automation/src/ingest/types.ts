import * as crypto from "crypto";
import { z } from "zod";
import { normalizeUrl } from "./normalizeUrl";

// ─── Schema de validación de BoiaCandidate ────────────────────────────────────

export const BoidaCandidateSchema = z.object({
  id: z.string().min(1, "id requerido"),
  title: z.string().min(10).max(500),
  summary: z.string().min(50).max(8000),
  source_url: z.string().url("source_url debe ser una URL válida"),
  published_at: z
    .string()
    .refine((v) => !isNaN(Date.parse(v)), "published_at debe ser ISO 8601")
    .refine(
      (v) => new Date(v).getTime() <= Date.now() + 2 * 60 * 60 * 1000,
      "published_at no puede ser futura"
    ),
  organism: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  tags: z.array(z.string().min(1).max(50)).min(0).max(30).default([]),
  boia_relevance_score: z
    .number()
    .min(0)
    .max(100, "boia_relevance_score debe estar entre 0 y 100"),
  why_it_matters: z.string().min(20).max(5000),
  affected_audience: z.array(z.string()).min(0).max(20).default([]),
  linkedin_angle: z.string().max(1000).optional(),
});

/** Tipo del payload crudo tal como viene de cualquier fuente BOIA */
export type RawBoiaCandidate = z.input<typeof BoidaCandidateSchema>;

/** Tipo validado + campos computados por el adapter */
export interface BoiaCandidate {
  // ── Campos originales de BOIA ──────────────────────────────────────────────
  id: string;
  title: string;
  summary: string;
  sourceUrl: string;
  publishedAt: string;
  organism: string;
  category: string;
  tags: string[];
  boiaRelevanceScore: number;
  whyItMatters: string;
  affectedAudience: string[];
  linkedinAngle?: string;
  // ── Campos computados por el adapter ──────────────────────────────────────
  /** SHA-256 de "boia::" + id + "::" + normalizedUrl */
  contentHash: string;
  /** Horas desde publishedAt hasta el momento de ingesta */
  ageHours: number;
  /** URL normalizada (sin tracking params) */
  normalizedSourceUrl: string;
}

/** Construye un BoiaCandidate a partir de datos validados */
export function buildBoiaCandidate(raw: z.output<typeof BoidaCandidateSchema>): BoiaCandidate {
  const normalizedUrl = normalizeUrl(raw.source_url);
  const contentHash = crypto
    .createHash("sha256")
    .update(`boia::${raw.id}::${normalizedUrl}`)
    .digest("hex");

  const ageHours = (Date.now() - new Date(raw.published_at).getTime()) / (1000 * 60 * 60);

  return {
    id: raw.id,
    title: raw.title.trim(),
    summary: raw.summary.trim(),
    sourceUrl: raw.source_url,
    publishedAt: raw.published_at,
    organism: raw.organism.trim(),
    category: raw.category.trim(),
    tags: raw.tags.map((t) => t.toLowerCase().trim()),
    boiaRelevanceScore: raw.boia_relevance_score,
    whyItMatters: raw.why_it_matters.trim(),
    affectedAudience: raw.affected_audience.map((a) => a.toLowerCase().trim()),
    linkedinAngle: raw.linkedin_angle?.trim(),
    contentHash,
    ageHours,
    normalizedSourceUrl: normalizedUrl,
  };
}
