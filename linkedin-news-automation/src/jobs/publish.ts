import "dotenv/config";
import { readNewsFile } from "../ingest/newsReader";
import { scoreItems } from "../scoring/scorer";
import { generatePost } from "../copy/generator";
import { publishPost } from "../linkedin/client";
import { isAlreadyProcessed, savePost, closeDb } from "../db";
import { config } from "../config";
import { logger } from "../config/logger";

export interface PublishResult {
  total: number;
  published: number;
  skipped_threshold: number;
  skipped_duplicate: number;
  failed: number;
}

/**
 * Pipeline completo: ingest → score → copy → publish → persist.
 */
export async function runPublishJob(): Promise<PublishResult> {
  const result: PublishResult = {
    total: 0,
    published: 0,
    skipped_threshold: 0,
    skipped_duplicate: 0,
    failed: 0,
  };

  logger.info("=== Iniciando job de publicación ===", {
    threshold: config.scoreThreshold,
    dryRun: config.dryRun,
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

  logger.info("Scoring completado", {
    items: scoredItems.length,
    aboveThreshold: scoredItems.filter((i) => i.score >= config.scoreThreshold).length,
  });

  // 3. Procesar cada ítem
  for (const item of scoredItems) {
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
        source_url: item.url,
        score: item.score,
        status: "skipped",
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

    // Generar post
    const generated = generatePost(item);

    logger.debug("Post generado", {
      charCount: generated.charCount,
      hashtags: generated.hashtags,
      preview: generated.text.substring(0, 100),
    });

    // Publicar
    try {
      const postUrn = await publishPost(generated.text);

      savePost({
        content_hash: item.contentHash,
        title: item.title,
        source_url: item.url,
        score: item.score,
        status: "published",
        linkedin_urn: postUrn,
        post_text: generated.text,
      });

      logger.info("Publicado exitosamente", { postUrn });
      result.published++;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("Error al publicar", { title: item.title, error: errMsg });

      savePost({
        content_hash: item.contentHash,
        title: item.title,
        source_url: item.url,
        score: item.score,
        status: "failed",
        post_text: generated.text,
        error_message: errMsg,
      });

      result.failed++;
    }
  }

  logger.info("=== Job finalizado ===", result);
  closeDb();
  return result;
}

// Ejecutar directamente si es el entry point
if (require.main === module) {
  runPublishJob()
    .then((result) => {
      console.log("\nResumen:", result);
      process.exit(result.failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      logger.error("Error fatal en el job de publicación", { error: String(err) });
      process.exit(1);
    });
}
