#!/usr/bin/env ts-node
/**
 * CLI para actualizar y consultar métricas de performance de posts publicados.
 *
 * Comandos:
 *   npm run update-metrics -- --list [--limit N]
 *   npm run update-metrics -- --analyze
 *   npm run update-metrics -- --id <uuid> --impressions N --likes N --comments N [--saves N]
 */

import "dotenv/config";
import { updatePostMetrics, getTopPerformingPosts } from "../src/performance/performanceService";
import { analyzePerformance, shouldPublish } from "../src/performance/feedbackLoop";
import { PostMetricsInputSchema } from "../src/performance/types";
import { closeDb } from "../src/db";

const flags = parseArgs(process.argv.slice(2));

async function main(): Promise<void> {
  try {
    if ("list" in flags) {
      await cmdList();
    } else if ("analyze" in flags) {
      await cmdAnalyze();
    } else if ("threshold" in flags) {
      await cmdThreshold();
    } else if ("id" in flags) {
      await cmdUpdate();
    } else {
      printUsage();
    }
  } finally {
    closeDb();
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function cmdList(): void {
  const limit = parseInt(String(flags["limit"] ?? "10"), 10);
  const posts = getTopPerformingPosts(limit);

  if (posts.length === 0) {
    console.log("No hay posts con datos de performance aún.");
    return;
  }

  console.log(`\nTop ${posts.length} posts por engagement rate:\n`);
  const h = [
    "ID".padEnd(38),
    "Eng.Rate".padEnd(10),
    "Impr.".padEnd(8),
    "Likes".padEnd(7),
    "Cmts".padEnd(6),
    "Título",
  ].join(" ");
  console.log(h);
  console.log("─".repeat(90));

  for (const p of posts) {
    console.log(
      [
        p.id.substring(0, 36).padEnd(38),
        `${(p.engagementRate * 100).toFixed(2)}%`.padEnd(10),
        String(p.impressions).padEnd(8),
        String(p.likes).padEnd(7),
        String(p.comments).padEnd(6),
        p.title.substring(0, 40),
      ].join(" ")
    );
  }
}

function cmdAnalyze(): void {
  const analysis = analyzePerformance();

  console.log("\n════════════════════════════════════════════");
  console.log("  Análisis de Performance Editorial");
  console.log("════════════════════════════════════════════\n");
  console.log(`  Correlación score↔engagement : ${analysis.correlation}`);
  console.log(`  Muestra                      : ${analysis.sampleSize} posts\n`);

  console.log("  Insights:");
  for (const insight of analysis.insights) {
    console.log(`    • ${insight}`);
  }

  if (analysis.suggestedWeightAdjustments.length > 0) {
    console.log("\n  Ajustes de peso sugeridos para editorialScorer.ts:");
    console.log(`  ${"Señal".padEnd(26)} ${"Actual".padEnd(8)} Sugerido`);
    console.log("  " + "─".repeat(45));
    for (const adj of analysis.suggestedWeightAdjustments) {
      const arrow = adj.suggestedWeight > adj.currentWeight ? "↑" : "↓";
      console.log(
        `  ${adj.signal.padEnd(26)} ${String(adj.currentWeight).padEnd(8)} ${adj.suggestedWeight} ${arrow}`
      );
    }
  } else {
    console.log("\n  No se sugieren ajustes de peso en este momento.");
  }
  console.log();
}

function cmdThreshold(): void {
  const score = parseInt(String(flags["score"] ?? "0"), 10);
  const hours = parseInt(String(flags["hours"] ?? "24"), 10);
  const decision = shouldPublish(score, hours);

  console.log(`\n  shouldPublish(score=${score}, window=${hours}h)`);
  console.log(`  → ${decision.should ? "✓ SÍ publicar" : "✗ NO publicar"}`);
  console.log(`  Razón     : ${decision.reason}`);
  if (decision.threshold > 0) {
    console.log(`  Umbral    : ${decision.threshold}`);
  }
  console.log(`  Publicados hoy: ${decision.publishedTodayCount}\n`);
}

function cmdUpdate(): void {
  const postId = String(flags["id"]);

  const parsed = PostMetricsInputSchema.safeParse({
    impressions: parseInt(String(flags["impressions"] ?? "0"), 10),
    likes:       parseInt(String(flags["likes"]       ?? "0"), 10),
    comments:    parseInt(String(flags["comments"]    ?? "0"), 10),
    saves:       "saves" in flags ? parseInt(String(flags["saves"]), 10) : undefined,
  });

  if (!parsed.success) {
    const errs = parsed.error.errors.map((e) => `${e.path}: ${e.message}`).join(", ");
    console.error(`Métricas inválidas: ${errs}`);
    process.exit(1);
  }

  const updated = updatePostMetrics(postId, parsed.data);

  if (!updated) {
    console.error(`Post no encontrado: ${postId}`);
    process.exit(1);
  }

  console.log(`\nMétricas actualizadas para ${postId}:`);
  console.log(`  Impresiones  : ${updated.impressions}`);
  console.log(`  Likes        : ${updated.likes}`);
  console.log(`  Comentarios  : ${updated.comments}`);
  if (updated.saves != null) console.log(`  Guardados    : ${updated.saves}`);
  console.log(`  Eng. rate    : ${(updated.engagementRate * 100).toFixed(3)}%\n`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseArgs(args: string[]): Record<string, string | true> {
  const result: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key  = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        result[key] = next;
        i++;
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}

function printUsage(): void {
  console.log(`
Uso: npm run update-metrics -- [opciones]

Consultar:
  --list [--limit N]               Listar top N posts por engagement (default: 10)
  --analyze                        Analizar correlación score↔engagement
  --threshold --score N [--hours H] ¿Se publicaría un candidato con ese score?

Actualizar:
  --id <uuid>                      ID del post a actualizar
    --impressions <n>              Impresiones totales
    --likes <n>                    Likes
    --comments <n>                 Comentarios
    --saves <n>                    Guardados (opcional)

Ejemplos:
  npm run update-metrics -- --list --limit 5
  npm run update-metrics -- --analyze
  npm run update-metrics -- --threshold --score 75
  npm run update-metrics -- --id abc-123 --impressions 1500 --likes 80 --comments 12
`);
}

main().catch((err) => {
  console.error("Error fatal:", err instanceof Error ? err.message : String(err));
  closeDb();
  process.exit(1);
});
