import "dotenv/config";
import { readNewsFile } from "../ingest/newsReader";
import { scoreItems, ScoredNewsItem } from "../scoring/scorer";
import { generatePost, GeneratedPost } from "../copy/generator";
import { isAlreadyProcessed, getRecentPosts, closeDb } from "../db";
import { config } from "../config";
import { logger } from "../config/logger";

export interface DryRunPreview {
  title: string;
  score: number;
  ageHours: number;
  scoreBreakdown: ScoredNewsItem["scoreBreakdown"];
  status: "would_publish" | "skipped_threshold" | "skipped_duplicate" | "skipped_copy_quality";
  skipReason?: string;
  post?: GeneratedPost;
}

export interface DryRunResult {
  total: number;
  would_publish: number;
  skipped_threshold: number;
  skipped_duplicate: number;
  skipped_copy_quality: number;
  previews: DryRunPreview[];
}

/**
 * Simula el pipeline completo sin publicar, ni guardar en DB como dry_run.
 * Solo lectura — seguro para ejecutar en cualquier momento.
 */
export async function runDryRun(): Promise<DryRunResult> {
  const result: DryRunResult = {
    total: 0,
    would_publish: 0,
    skipped_threshold: 0,
    skipped_duplicate: 0,
    skipped_copy_quality: 0,
    previews: [],
  };

  logger.info("=== DRY RUN (solo lectura) ===", {
    threshold: config.scoreThreshold,
    maxPostsPerRun: config.maxPostsPerRun,
  });

  const newsItems = readNewsFile();
  result.total = newsItems.length;

  const scoredItems = scoreItems(newsItems);

  const recentPosts = getRecentPosts(config.recentPostsToCheck, "published");
  const recentPostTexts = recentPosts
    .map((p) => p.copy_text ?? p.post_text ?? "")
    .filter(Boolean);

  let candidateCount = 0;

  for (const item of scoredItems) {
    const preview: DryRunPreview = {
      title: item.title,
      score: item.score,
      ageHours: item.ageHours,
      scoreBreakdown: item.scoreBreakdown,
      status: "would_publish",
    };

    if (item.score < config.scoreThreshold) {
      preview.status = "skipped_threshold";
      preview.skipReason = `Score ${item.score} < umbral ${config.scoreThreshold}`;
      result.skipped_threshold++;
      result.previews.push(preview);
      continue;
    }

    if (isAlreadyProcessed(item.contentHash)) {
      preview.status = "skipped_duplicate";
      preview.skipReason = `Hash ${item.contentHash.substring(0, 12)} ya en DB`;
      result.skipped_duplicate++;
      result.previews.push(preview);
      continue;
    }

    if (candidateCount >= config.maxPostsPerRun) {
      preview.status = "skipped_threshold";
      preview.skipReason = `Límite de ${config.maxPostsPerRun} posts/run alcanzado`;
      result.skipped_threshold++;
      result.previews.push(preview);
      continue;
    }

    const copyResult = generatePost(item, recentPostTexts);

    if (!copyResult.ok) {
      preview.status = "skipped_copy_quality";
      preview.skipReason = copyResult.reason;
      result.skipped_copy_quality++;
      result.previews.push(preview);
      continue;
    }

    preview.status = "would_publish";
    preview.post = copyResult.post;
    result.would_publish++;
    candidateCount++;

    // Agregar el texto generado a los recientes para que afecte los siguientes ítems
    recentPostTexts.unshift(copyResult.post.text);
    result.previews.push(preview);
  }

  printReport(result);
  closeDb();
  return result;
}

function printReport(result: DryRunResult): void {
  const line = "═".repeat(72);
  const sep = "─".repeat(72);

  console.log(`\n${line}`);
  console.log("  DRY RUN — REPORTE DE PUBLICACIONES");
  console.log(line);
  console.log(`  Noticias procesadas       : ${result.total}`);
  console.log(`  Se publicarían            : ${result.would_publish}`);
  console.log(`  Saltadas (score bajo)     : ${result.skipped_threshold}`);
  console.log(`  Saltadas (duplicado)      : ${result.skipped_duplicate}`);
  console.log(`  Saltadas (copy débil)     : ${result.skipped_copy_quality}`);
  console.log(line);

  const toPublish = result.previews.filter((p) => p.status === "would_publish");
  const skipped = result.previews.filter((p) => p.status !== "would_publish");

  if (toPublish.length === 0) {
    console.log("\n  No hay posts para publicar en esta corrida.\n");
  } else {
    for (let i = 0; i < toPublish.length; i++) {
      const p = toPublish[i];
      console.log(`\n  ── POST ${i + 1}/${toPublish.length} ${"─".repeat(50 - String(i + 1).length)}`);
      console.log(`  Título        : ${p.title}`);
      console.log(`  Score         : ${p.score}/100`);
      console.log(
        `  Breakdown     : recency=${p.scoreBreakdown.recency}` +
        ` tags=${p.scoreBreakdown.tagRelevance}` +
        ` source=${p.scoreBreakdown.sourceCredibility}` +
        ` length=${p.scoreBreakdown.contentLength}` +
        ` bonus=${p.scoreBreakdown.bonus}` +
        ` penalty=-${p.scoreBreakdown.penalty}`
      );
      console.log(`  Tags relevantes: ${[...p.scoreBreakdown.matchedHighTags, ...p.scoreBreakdown.matchedMediumTags].join(", ") || "ninguno"}`);
      if (p.post) {
        console.log(`  Chars/Quality : ${p.post.charCount} chars | quality=${p.post.qualityScore}/100`);
        console.log(`  Hashtags      : ${p.post.hashtags.join(" ")}`);
        console.log(`\n  TEXTO DEL POST:`);
        console.log(`  ${p.post.text.split("\n").join("\n  ")}`);
      }
    }
  }

  if (skipped.length > 0) {
    console.log(`\n${sep}`);
    console.log("  SALTADAS:");
    for (const p of skipped) {
      const icon = p.status === "skipped_duplicate" ? "⟳" :
                   p.status === "skipped_copy_quality" ? "✗" : "↓";
      console.log(`  ${icon} [${p.score}] ${p.title.substring(0, 60)}`);
      if (p.skipReason) console.log(`      → ${p.skipReason}`);
    }
  }

  console.log(`\n${line}\n`);
}

if (require.main === module) {
  runDryRun()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error("Error fatal en dry-run", { error: String(err) });
      process.exit(1);
    });
}
