import "dotenv/config";
import { fetchBoidaCandidates } from "../ingest";
import { scoreCandidates, ScoredBoiaCandidate } from "../scoring/editorialScorer";
import { generatePost, GeneratedPost } from "../copy/generator";
import { isAlreadyProcessed, getRecentPosts, closeDb } from "../db";
import { config } from "../config";
import { logger } from "../config/logger";

export interface DryRunPreview {
  id: string;
  title: string;
  organism: string;
  boiaScore: number;
  linkedinScore: number;
  ageHours: number;
  scoreBreakdown: ScoredBoiaCandidate["scoreBreakdown"];
  status:
    | "would_publish"
    | "skipped_boia_score"
    | "skipped_linkedin_score"
    | "skipped_duplicate"
    | "skipped_copy_quality"
    | "skipped_organism_throttle"
    | "skipped_limit";
  skipReason?: string;
  post?: GeneratedPost;
}

export interface DryRunResult {
  total: number;
  would_publish: number;
  skipped_boia_score: number;
  skipped_linkedin_score: number;
  skipped_duplicate: number;
  skipped_copy_quality: number;
  skipped_organism_throttle: number;
  previews: DryRunPreview[];
}

/** Simulación completa, solo lectura. No escribe en DB ni publica. */
export async function runDryRun(): Promise<DryRunResult> {
  const result: DryRunResult = {
    total: 0,
    would_publish: 0,
    skipped_boia_score: 0,
    skipped_linkedin_score: 0,
    skipped_duplicate: 0,
    skipped_copy_quality: 0,
    skipped_organism_throttle: 0,
    previews: [],
  };

  logger.info("=== DRY RUN (solo lectura) ===", {
    source: config.boiaSource,
    boiaMinRelevance: config.boiaMinRelevance,
    linkedinMinScore: config.linkedinMinScore,
    maxPostsPerRun: config.maxPostsPerRun,
  });

  const candidates = await fetchBoidaCandidates();
  result.total = candidates.length;

  const scored = scoreCandidates(candidates);

  const recentPosts = getRecentPosts(config.recentPostsToCheck, "published");
  const recentPostTexts = recentPosts
    .map((p) => p.copy_text ?? p.post_text ?? "")
    .filter(Boolean);

  const organismsThisRun = new Map<string, number>();
  let candidateCount = 0;

  for (const candidate of scored) {
    const preview: DryRunPreview = {
      id: candidate.id,
      title: candidate.title,
      organism: candidate.organism,
      boiaScore: candidate.boiaRelevanceScore,
      linkedinScore: candidate.linkedinPublishScore,
      ageHours: candidate.ageHours,
      scoreBreakdown: candidate.scoreBreakdown,
      status: "would_publish",
    };

    if (candidate.boiaRelevanceScore < config.boiaMinRelevance) {
      preview.status = "skipped_boia_score";
      preview.skipReason = `boiaScore ${candidate.boiaRelevanceScore} < ${config.boiaMinRelevance}`;
      result.skipped_boia_score++;
      result.previews.push(preview);
      continue;
    }

    if (candidate.linkedinPublishScore < config.linkedinMinScore) {
      preview.status = "skipped_linkedin_score";
      preview.skipReason = `linkedinScore ${candidate.linkedinPublishScore} < ${config.linkedinMinScore}`;
      result.skipped_linkedin_score++;
      result.previews.push(preview);
      continue;
    }

    if (isAlreadyProcessed(candidate.contentHash)) {
      preview.status = "skipped_duplicate";
      preview.skipReason = `Hash ${candidate.contentHash.substring(0, 12)} ya en DB`;
      result.skipped_duplicate++;
      result.previews.push(preview);
      continue;
    }

    const orgKey = candidate.organism.toLowerCase().trim();
    const prevScore = organismsThisRun.get(orgKey);
    if (prevScore !== undefined && candidate.linkedinPublishScore < config.linkedinExceptionalScore) {
      preview.status = "skipped_organism_throttle";
      preview.skipReason = `${candidate.organism} ya incluido (score=${prevScore}). Requiere >= ${config.linkedinExceptionalScore}`;
      result.skipped_organism_throttle++;
      result.previews.push(preview);
      continue;
    }

    if (candidateCount >= config.maxPostsPerRun) {
      preview.status = "skipped_limit";
      preview.skipReason = `Límite de ${config.maxPostsPerRun} posts/run alcanzado`;
      result.previews.push(preview);
      continue;
    }

    const copyResult = generatePost(candidate, recentPostTexts);
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
    recentPostTexts.unshift(copyResult.post.text);
    organismsThisRun.set(orgKey, candidate.linkedinPublishScore);
    result.previews.push(preview);
  }

  printReport(result);
  closeDb();
  return result;
}

function printReport(result: DryRunResult): void {
  const L = "═".repeat(72);
  const S = "─".repeat(72);

  console.log(`\n${L}`);
  console.log("  DRY RUN — CANDIDATOS BOIA → LINKEDIN");
  console.log(L);
  console.log(`  Candidatos BOIA recibidos     : ${result.total}`);
  console.log(`  Se publicarían                : ${result.would_publish}`);
  console.log(`  Saltados (boia score bajo)    : ${result.skipped_boia_score}`);
  console.log(`  Saltados (linkedin score bajo): ${result.skipped_linkedin_score}`);
  console.log(`  Saltados (duplicado)          : ${result.skipped_duplicate}`);
  console.log(`  Saltados (copy débil)         : ${result.skipped_copy_quality}`);
  console.log(`  Saltados (throttle organismo) : ${result.skipped_organism_throttle}`);
  console.log(L);

  const toPublish = result.previews.filter((p) => p.status === "would_publish");

  if (toPublish.length === 0) {
    console.log("\n  No hay posts para publicar en esta corrida.\n");
  } else {
    for (let i = 0; i < toPublish.length; i++) {
      const p = toPublish[i];
      const bd = p.scoreBreakdown;
      console.log(`\n  ── POST ${i + 1}/${toPublish.length} [${"─".repeat(55)}]`);
      console.log(`  ID            : ${p.id}`);
      console.log(`  Título        : ${p.title}`);
      console.log(`  Organismo     : ${p.organism}`);
      console.log(`  BOIA score    : ${p.boiaScore}/100`);
      console.log(`  LinkedIn score: ${p.linkedinScore}/100`);
      console.log(
        `  Breakdown     : organism=${bd.organismRelevance} audience=${bd.audienceImpact}` +
        ` clarity=${bd.messageClarity} recency=${bd.recency}` +
        ` conversation=${bd.conversationPotential} bonus=${bd.dataBonus} penalty=-${bd.technicalityPenalty}`
      );
      console.log(`  Audiencia     : ${bd.matchedAudience.join(", ") || "—"}`);
      if (p.post) {
        console.log(`  Chars/Quality : ${p.post.charCount} chars | quality=${p.post.qualityScore}/100`);
        console.log(`  Hashtags      : ${p.post.hashtags.join(" ")}`);
        console.log(`\n  TEXTO DEL POST:`);
        console.log(`  ${p.post.text.split("\n").join("\n  ")}`);
      }
    }
  }

  const skipped = result.previews.filter((p) => p.status !== "would_publish");
  if (skipped.length > 0) {
    console.log(`\n${S}`);
    console.log("  SALTADOS:");
    for (const p of skipped) {
      const icon =
        p.status === "skipped_duplicate" ? "⟳" :
        p.status === "skipped_copy_quality" ? "✗" :
        p.status === "skipped_organism_throttle" ? "⚡" : "↓";
      console.log(`  ${icon} [boia=${p.boiaScore} li=${p.linkedinScore}] ${p.title.substring(0, 60)}`);
      if (p.skipReason) console.log(`      → ${p.skipReason}`);
    }
  }

  console.log(`\n${L}\n`);
}

if (require.main === module) {
  runDryRun()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error("Error fatal en dry-run", { error: String(err) });
      process.exit(1);
    });
}
