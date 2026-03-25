import "dotenv/config";
import { readNewsFile } from "../ingest/newsReader";
import { scoreItems, ScoredNewsItem } from "../scoring/scorer";
import { generatePost, GeneratedPost } from "../copy/generator";
import { isAlreadyProcessed, savePost, closeDb } from "../db";
import { config } from "../config";
import { logger } from "../config/logger";

export interface DryRunResult {
  total: number;
  would_publish: number;
  skipped_threshold: number;
  skipped_duplicate: number;
  previews: DryRunPreview[];
}

export interface DryRunPreview {
  title: string;
  score: number;
  scoreBreakdown: ScoredNewsItem["scoreBreakdown"];
  status: "would_publish" | "skipped_threshold" | "skipped_duplicate";
  post?: GeneratedPost;
}

/**
 * Simula el pipeline completo sin publicar nada en LinkedIn.
 * Muestra en consola los posts que serían publicados.
 */
export async function runDryRun(): Promise<DryRunResult> {
  const result: DryRunResult = {
    total: 0,
    would_publish: 0,
    skipped_threshold: 0,
    skipped_duplicate: 0,
    previews: [],
  };

  logger.info("=== DRY RUN — no se publicará nada en LinkedIn ===", {
    threshold: config.scoreThreshold,
  });

  const newsItems = readNewsFile();
  result.total = newsItems.length;

  const scoredItems = scoreItems(newsItems);

  for (const item of scoredItems) {
    const preview: DryRunPreview = {
      title: item.title,
      score: item.score,
      scoreBreakdown: item.scoreBreakdown,
      status: "would_publish",
    };

    if (item.score < config.scoreThreshold) {
      preview.status = "skipped_threshold";
      result.skipped_threshold++;
      result.previews.push(preview);
      continue;
    }

    if (isAlreadyProcessed(item.contentHash)) {
      preview.status = "skipped_duplicate";
      result.skipped_duplicate++;
      result.previews.push(preview);
      continue;
    }

    const generated = generatePost(item);
    preview.post = generated;
    preview.status = "would_publish";
    result.would_publish++;
    result.previews.push(preview);

    // Persistir como dry_run para historial
    savePost({
      content_hash: item.contentHash,
      title: item.title,
      source_url: item.url,
      score: item.score,
      status: "dry_run",
      post_text: generated.text,
    });
  }

  // Imprimir resumen legible
  printDryRunReport(result);

  closeDb();
  return result;
}

function printDryRunReport(result: DryRunResult): void {
  console.log("\n" + "═".repeat(70));
  console.log("  DRY RUN — REPORTE DE PUBLICACIONES");
  console.log("═".repeat(70));
  console.log(`  Total noticias procesadas : ${result.total}`);
  console.log(`  Se publicarían            : ${result.would_publish}`);
  console.log(`  Saltadas (score bajo)     : ${result.skipped_threshold}`);
  console.log(`  Saltadas (duplicado)      : ${result.skipped_duplicate}`);
  console.log("═".repeat(70));

  const toPublish = result.previews.filter((p) => p.status === "would_publish");

  if (toPublish.length === 0) {
    console.log("\n  No hay posts para publicar en esta corrida.");
  } else {
    for (let i = 0; i < toPublish.length; i++) {
      const preview = toPublish[i];
      console.log(`\n  ── POST ${i + 1} / ${toPublish.length} ──────────────────────────────────`);
      console.log(`  Título  : ${preview.title}`);
      console.log(`  Score   : ${preview.score}/100`);
      console.log(
        `  Breakdown: recency=${preview.scoreBreakdown.recency} ` +
        `tags=${preview.scoreBreakdown.tagRelevance} ` +
        `source=${preview.scoreBreakdown.sourceCredibility} ` +
        `length=${preview.scoreBreakdown.contentLength} ` +
        `bonus=${preview.scoreBreakdown.bonus}`
      );
      if (preview.post) {
        console.log(`  Chars   : ${preview.post.charCount}`);
        console.log(`  Tags    : ${preview.post.hashtags.join(" ")}`);
        console.log("\n  TEXTO DEL POST:");
        console.log("  " + preview.post.text.split("\n").join("\n  "));
      }
    }
  }

  console.log("\n" + "═".repeat(70) + "\n");
}

// Entry point directo
if (require.main === module) {
  runDryRun()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error("Error fatal en dry-run", { error: String(err) });
      process.exit(1);
    });
}
