import "dotenv/config";
import { fetchBoidaCandidates } from "../ingest";
import { scoreCandidates } from "../scoring/editorialScorer";
import { generatePost } from "../copy/generator";
import { publishPost, LinkedInApiError, extractPostId } from "../linkedin/client";
import {
  isAlreadyProcessed,
  savePost,
  getRecentPosts,
  acquireLock,
  releaseLock,
  closeDb,
  FailureReason,
} from "../db";
import { createPostPerformance } from "../performance/performanceService";
import { config } from "../config";
import { logger } from "../config/logger";

export interface PublishResult {
  total: number;
  published: number;
  pending_approval: number;
  skipped_boia_score: number;
  skipped_linkedin_score: number;
  skipped_duplicate: number;
  skipped_copy_quality: number;
  skipped_organism_throttle: number;
  failed: number;
}

export async function runPublishJob(): Promise<PublishResult> {
  const result: PublishResult = {
    total: 0,
    published: 0,
    pending_approval: 0,
    skipped_boia_score: 0,
    skipped_linkedin_score: 0,
    skipped_duplicate: 0,
    skipped_copy_quality: 0,
    skipped_organism_throttle: 0,
    failed: 0,
  };

  const lockAcquired = acquireLock();
  if (!lockAcquired) {
    logger.warn("Job abortado: otra instancia está en ejecución");
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
  logger.info("=== Iniciando job de publicación BOIA → LinkedIn ===", {
    source: config.boiaSource,
    boiaMinRelevance: config.boiaMinRelevance,
    linkedinMinScore: config.linkedinMinScore,
    maxPostsPerRun: config.maxPostsPerRun,
    dryRun: config.dryRun,
    approvalRequired: config.approvalRequired,
  });

  // 1. Fetch desde BOIA
  const candidates = await fetchBoidaCandidates();
  result.total = candidates.length;

  if (candidates.length === 0) {
    logger.warn("No se encontraron candidatos BOIA");
    return result;
  }

  // 2. Scoring editorial para LinkedIn
  const scored = scoreCandidates(candidates);

  logger.info("Scoring completado", {
    total: scored.length,
    passBoiaMin: scored.filter((c) => c.boiaRelevanceScore >= config.boiaMinRelevance).length,
    passLinkedinMin: scored.filter((c) => c.linkedinPublishScore >= config.linkedinMinScore).length,
    top: scored[0] ? `${scored[0].title.substring(0, 50)} (boia=${scored[0].boiaRelevanceScore}, li=${scored[0].linkedinPublishScore})` : "—",
  });

  // 3. Textos de posts recientes para overlap check
  const recentPosts = getRecentPosts(config.recentPostsToCheck, "published");
  const recentPostTexts = recentPosts
    .map((p) => p.copy_text ?? p.post_text ?? "")
    .filter(Boolean);

  // 4. Throttle por organismo: track de organismos publicados en esta corrida
  const organismsThisRun = new Map<string, number>(); // organism → score del publicado

  let publishedThisRun = 0;

  for (const candidate of scored) {
    if (publishedThisRun >= config.maxPostsPerRun) {
      logger.info("Límite de posts por corrida alcanzado", { limit: config.maxPostsPerRun });
      break;
    }

    const logCtx = {
      id: candidate.id,
      title: candidate.title.substring(0, 60),
      boiaScore: candidate.boiaRelevanceScore,
      linkedinScore: candidate.linkedinPublishScore,
    };

    logger.info("Procesando candidato", logCtx);

    // ── Filtro 1: boia_relevance_score ─────────────────────────────────────
    if (candidate.boiaRelevanceScore < config.boiaMinRelevance) {
      logger.info("Saltando: boia_relevance_score bajo umbral", {
        score: candidate.boiaRelevanceScore,
        min: config.boiaMinRelevance,
      });
      savePost(buildSkipRecord(candidate, "boia_score",
        `boiaRelevanceScore ${candidate.boiaRelevanceScore} < ${config.boiaMinRelevance}`));
      result.skipped_boia_score++;
      continue;
    }

    // ── Filtro 2: linkedin_publish_score ───────────────────────────────────
    if (candidate.linkedinPublishScore < config.linkedinMinScore) {
      logger.info("Saltando: linkedin_publish_score bajo umbral", {
        score: candidate.linkedinPublishScore,
        min: config.linkedinMinScore,
      });
      savePost(buildSkipRecord(candidate, "linkedin_score",
        `linkedinPublishScore ${candidate.linkedinPublishScore} < ${config.linkedinMinScore}`));
      result.skipped_linkedin_score++;
      continue;
    }

    // ── Filtro 3: deduplicación ────────────────────────────────────────────
    if (isAlreadyProcessed(candidate.contentHash)) {
      logger.info("Saltando: ya fue procesado", { hash: candidate.contentHash.substring(0, 12) });
      result.skipped_duplicate++;
      continue;
    }

    // ── Filtro 4: throttle por organismo ───────────────────────────────────
    const orgKey = candidate.organism.toLowerCase().trim();
    const prevScore = organismsThisRun.get(orgKey);
    if (prevScore !== undefined) {
      const isExceptional = candidate.linkedinPublishScore >= config.linkedinExceptionalScore;
      if (!isExceptional) {
        logger.info("Saltando: throttle por organismo", {
          organism: candidate.organism,
          prevScore,
          currentScore: candidate.linkedinPublishScore,
          exceptionalThreshold: config.linkedinExceptionalScore,
        });
        savePost(buildSkipRecord(candidate, "organism_throttle",
          `Organismo ${candidate.organism} ya publicado en esta corrida (score=${prevScore}). Requiere >= ${config.linkedinExceptionalScore} para publicar segundo item.`));
        result.skipped_organism_throttle++;
        continue;
      }
      logger.info("Score excepcional: publicando segundo item del mismo organismo", {
        organism: candidate.organism,
        score: candidate.linkedinPublishScore,
      });
    }

    // ── Generar copy ───────────────────────────────────────────────────────
    const copyResult = generatePost(candidate, recentPostTexts);

    if (!copyResult.ok) {
      logger.warn("Copy rechazado", { id: candidate.id, reason: copyResult.reason });
      savePost(buildSkipRecord(candidate, "copy_quality", copyResult.reason, candidate.linkedinPublishScore));
      result.skipped_copy_quality++;
      continue;
    }

    const { post } = copyResult;

    // ── Modo approval ──────────────────────────────────────────────────────
    if (config.approvalRequired && !config.dryRun) {
      savePost({
        content_hash: candidate.contentHash,
        title: candidate.title,
        source_url: candidate.normalizedSourceUrl,
        score: candidate.linkedinPublishScore,
        status: "pending_approval",
        boia_candidate_id: candidate.id,
        boia_relevance_score: candidate.boiaRelevanceScore,
        linkedin_publish_score: candidate.linkedinPublishScore,
        organism: candidate.organism,
        category: candidate.category,
        copy_text: post.text,
        post_text: post.text,
        copy_quality_score: post.qualityScore,
        score_breakdown: JSON.stringify(candidate.scoreBreakdown),
      });
      logger.info("Post guardado para aprobación manual", logCtx);
      result.pending_approval++;
      continue;
    }

    // ── Dry run ────────────────────────────────────────────────────────────
    if (config.dryRun) {
      logger.info("[DRY RUN] Post listo para publicar", {
        ...logCtx,
        charCount: post.charCount,
        qualityScore: post.qualityScore,
        preview: post.text.substring(0, 120),
      });
      result.published++;
      publishedThisRun++;
      recentPostTexts.unshift(post.text);
      organismsThisRun.set(orgKey, candidate.linkedinPublishScore);
      continue;
    }

    // ── Publicar en LinkedIn ───────────────────────────────────────────────
    try {
      const postUrn = await publishPost(post.text);
      const postId = extractPostId(postUrn);

      savePost({
        content_hash: candidate.contentHash,
        title: candidate.title,
        source_url: candidate.normalizedSourceUrl,
        score: candidate.linkedinPublishScore,
        status: "published",
        boia_candidate_id: candidate.id,
        boia_relevance_score: candidate.boiaRelevanceScore,
        linkedin_publish_score: candidate.linkedinPublishScore,
        organism: candidate.organism,
        category: candidate.category,
        linkedin_urn: postUrn,
        linkedin_post_id: postId,
        copy_text: post.text,
        post_text: post.text,
        copy_quality_score: post.qualityScore,
        score_breakdown: JSON.stringify(candidate.scoreBreakdown),
        published_at_real: new Date().toISOString(),
      });

      createPostPerformance(
        candidate.id,
        candidate.title,
        candidate.normalizedSourceUrl,
        candidate.linkedinPublishScore
      );

      logger.info("Publicado exitosamente", { ...logCtx, postUrn, postId });
      result.published++;
      publishedThisRun++;
      recentPostTexts.unshift(post.text);
      organismsThisRun.set(orgKey, candidate.linkedinPublishScore);
    } catch (error) {
      const isTyped = error instanceof LinkedInApiError;
      const errMsg = isTyped ? error.message : String(error);
      const failureReason: FailureReason = isTyped ? error.kind : "unknown";

      logger.error("Error al publicar", { ...logCtx, kind: failureReason, error: errMsg });

      savePost({
        content_hash: candidate.contentHash,
        title: candidate.title,
        source_url: candidate.normalizedSourceUrl,
        score: candidate.linkedinPublishScore,
        status: "failed",
        boia_candidate_id: candidate.id,
        boia_relevance_score: candidate.boiaRelevanceScore,
        linkedin_publish_score: candidate.linkedinPublishScore,
        organism: candidate.organism,
        category: candidate.category,
        copy_text: post.text,
        post_text: post.text,
        error_message: errMsg,
        failure_reason: failureReason,
        score_breakdown: JSON.stringify(candidate.scoreBreakdown),
      });

      result.failed++;

      if (failureReason === "auth_error" || failureReason === "scope_error") {
        logger.error("Error de autenticación — abortando resto del job", { kind: failureReason });
        break;
      }
    }
  }

  logger.info("=== Job finalizado ===", result);
  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSkipRecord(
  candidate: ReturnType<typeof scoreCandidates>[number],
  reason: FailureReason,
  message: string,
  linkedinScore?: number
) {
  return {
    content_hash: candidate.contentHash,
    title: candidate.title,
    source_url: candidate.normalizedSourceUrl,
    score: linkedinScore ?? candidate.linkedinPublishScore,
    status: "skipped" as const,
    boia_candidate_id: candidate.id,
    boia_relevance_score: candidate.boiaRelevanceScore,
    linkedin_publish_score: linkedinScore ?? candidate.linkedinPublishScore,
    organism: candidate.organism,
    category: candidate.category,
    failure_reason: reason,
    error_message: message,
    score_breakdown: JSON.stringify(candidate.scoreBreakdown),
  };
}

if (require.main === module) {
  runPublishJob()
    .then((result) => {
      console.log("\nResumen:", JSON.stringify(result, null, 2));
      process.exit(result.failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      logger.error("Error fatal", { error: String(err) });
      process.exit(1);
    });
}
