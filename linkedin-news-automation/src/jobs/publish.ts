import "dotenv/config";
import { readNewsFile } from "../ingest/newsReader";
import { scoreItems } from "../scoring/scorer";
import { generatePost } from "../copy/generator";
import { publishPost, LinkedInApiError, extractPostId } from "../linkedin/client";
import {
  isAlreadyProcessed,
  savePost,
  getRecentPosts,
  acquireLock,
  releaseLock,
  closeDb,
} from "../db";
import { config } from "../config";
import { logger } from "../config/logger";

export interface PublishResult {
  total: number;
  published: number;
  pending_approval: number;
  skipped_threshold: number;
  skipped_duplicate: number;
  skipped_copy_quality: number;
  failed: number;
}

/**
 * Pipeline completo: ingest → score → copy → [publish | pending] → persist.
 *
 * Garantías operativas:
 *   - Lock de ejecución concurrente: aborta si hay otro proceso activo
 *   - Límite de posts por corrida: MAX_POSTS_PER_RUN
 *   - Modo approval: guarda posts para revisión manual en lugar de publicar
 */
export async function runPublishJob(): Promise<PublishResult> {
  const result: PublishResult = {
    total: 0,
    published: 0,
    pending_approval: 0,
    skipped_threshold: 0,
    skipped_duplicate: 0,
    skipped_copy_quality: 0,
    failed: 0,
  };

  // ── Lock de concurrencia ──────────────────────────────────────────────────
  const lockAcquired = acquireLock();
  if (!lockAcquired) {
    logger.warn("Job abortado: otra instancia está en ejecución (lock activo)");
    return result;
  }

  try {
    return await runPipeline(result);
  } finally {
    releaseLock();
    closeDb();
  }
}

async function runPipeline(result: PublishResult): Promise<PublishResult> {
  logger.info("=== Iniciando job de publicación ===", {
    threshold: config.scoreThreshold,
    dryRun: config.dryRun,
    approvalRequired: config.approvalRequired,
    maxPostsPerRun: config.maxPostsPerRun,
  });

  // 1. Ingest
  const newsItems = readNewsFile();
  result.total = newsItems.length;

  if (newsItems.length === 0) {
    logger.warn("No se encontraron noticias en el archivo de entrada");
    return result;
  }

  // 2. Scoring
  const scoredItems = scoreItems(newsItems);
  const aboveThreshold = scoredItems.filter((i) => i.score >= config.scoreThreshold);

  logger.info("Scoring completado", {
    total: scoredItems.length,
    aboveThreshold: aboveThreshold.length,
    topScore: scoredItems[0]?.score,
  });

  // 3. Cargar textos recientes para validación de overlap en copy
  const recentPosts = getRecentPosts(config.recentPostsToCheck, "published");
  const recentPostTexts = recentPosts
    .map((p) => p.copy_text ?? p.post_text ?? "")
    .filter(Boolean);

  let publishedThisRun = 0;

  // 4. Procesar cada ítem (ya ordenados por score desc)
  for (const item of scoredItems) {
    if (publishedThisRun >= config.maxPostsPerRun) {
      logger.info("Límite de posts por corrida alcanzado", {
        limit: config.maxPostsPerRun,
      });
      break;
    }

    logger.info("Procesando noticia", {
      title: item.title.substring(0, 70),
      score: item.score,
      ageHours: Math.round(item.ageHours),
    });

    // Verificar umbral
    if (item.score < config.scoreThreshold) {
      logger.info("Saltando: score bajo el umbral", {
        score: item.score,
        threshold: config.scoreThreshold,
      });
      savePost({
        content_hash: item.contentHash,
        title: item.title,
        source_url: item.normalizedUrl,
        score: item.score,
        status: "skipped",
        score_breakdown: JSON.stringify(item.scoreBreakdown),
      });
      result.skipped_threshold++;
      continue;
    }

    // Verificar duplicado
    if (isAlreadyProcessed(item.contentHash)) {
      logger.info("Saltando: ya fue procesado anteriormente", {
        hash: item.contentHash.substring(0, 12),
      });
      result.skipped_duplicate++;
      continue;
    }

    // Generar copy
    const copyResult = generatePost(item, recentPostTexts);

    if (!copyResult.ok) {
      logger.warn("Copy rechazado, saltando noticia", {
        title: item.title.substring(0, 60),
        reason: copyResult.reason,
      });
      savePost({
        content_hash: item.contentHash,
        title: item.title,
        source_url: item.normalizedUrl,
        score: item.score,
        status: "skipped",
        failure_reason: "copy_quality",
        error_message: copyResult.reason,
        score_breakdown: JSON.stringify(item.scoreBreakdown),
      });
      result.skipped_copy_quality++;
      continue;
    }

    const { post: generated } = copyResult;

    // ── Modo approval: guardar para revisión manual ──────────────────────────
    if (config.approvalRequired && !config.dryRun) {
      savePost({
        content_hash: item.contentHash,
        title: item.title,
        source_url: item.normalizedUrl,
        score: item.score,
        status: "pending_approval",
        copy_text: generated.text,
        post_text: generated.text,
        copy_quality_score: generated.qualityScore,
        score_breakdown: JSON.stringify(item.scoreBreakdown),
      });
      logger.info("Post guardado para aprobación manual", {
        title: item.title.substring(0, 60),
        score: item.score,
        qualityScore: generated.qualityScore,
      });
      result.pending_approval++;
      continue;
    }

    // ── Dry run: registrar sin publicar ──────────────────────────────────────
    if (config.dryRun) {
      savePost({
        content_hash: item.contentHash,
        title: item.title,
        source_url: item.normalizedUrl,
        score: item.score,
        status: "dry_run",
        copy_text: generated.text,
        post_text: generated.text,
        copy_quality_score: generated.qualityScore,
        score_breakdown: JSON.stringify(item.scoreBreakdown),
      });
      logger.info("[DRY RUN] Post listo para publicar", {
        score: item.score,
        charCount: generated.charCount,
        qualityScore: generated.qualityScore,
      });
      result.published++;
      publishedThisRun++;
      continue;
    }

    // ── Publicar en LinkedIn ──────────────────────────────────────────────────
    try {
      const postUrn = await publishPost(generated.text);
      const postId = extractPostId(postUrn);

      savePost({
        content_hash: item.contentHash,
        title: item.title,
        source_url: item.normalizedUrl,
        score: item.score,
        status: "published",
        linkedin_urn: postUrn,
        linkedin_post_id: postId,
        copy_text: generated.text,
        post_text: generated.text,
        copy_quality_score: generated.qualityScore,
        score_breakdown: JSON.stringify(item.scoreBreakdown),
        published_at_real: new Date().toISOString(),
      });

      logger.info("Publicado exitosamente", {
        postUrn,
        postId,
        title: item.title.substring(0, 60),
      });

      result.published++;
      publishedThisRun++;

      // Agregar el texto publicado a la lista de recientes para el overlap check
      recentPostTexts.unshift(generated.text);

    } catch (error) {
      const isTypedError = error instanceof LinkedInApiError;
      const errMsg = isTypedError ? error.message : String(error);
      const failureReason = isTypedError ? error.kind : "unknown";

      logger.error("Error al publicar", {
        title: item.title.substring(0, 60),
        kind: failureReason,
        error: errMsg,
      });

      savePost({
        content_hash: item.contentHash,
        title: item.title,
        source_url: item.normalizedUrl,
        score: item.score,
        status: "failed",
        copy_text: generated.text,
        post_text: generated.text,
        error_message: errMsg,
        failure_reason: failureReason,
        score_breakdown: JSON.stringify(item.scoreBreakdown),
      });

      result.failed++;

      // Ante errores de auth/scope no tiene sentido seguir con más posts
      if (failureReason === "auth_error" || failureReason === "scope_error") {
        logger.error("Error de autenticación/permisos — abortando el resto del job", {
          kind: failureReason,
        });
        break;
      }
    }
  }

  logger.info("=== Job finalizado ===", result);
  return result;
}

// Ejecutar directamente si es el entry point
if (require.main === module) {
  runPublishJob()
    .then((result) => {
      console.log("\nResumen:", JSON.stringify(result, null, 2));
      process.exit(result.failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      logger.error("Error fatal en el job de publicación", { error: String(err) });
      process.exit(1);
    });
}
