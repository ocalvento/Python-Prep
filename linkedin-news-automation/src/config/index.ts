import * as dotenv from "dotenv";
import { z } from "zod";
import * as path from "path";

dotenv.config();

const ConfigSchema = z.object({
  // ── LinkedIn OAuth ──────────────────────────────────────────────────────────
  linkedinClientId: z.string().min(1, "LINKEDIN_CLIENT_ID es requerido"),
  linkedinClientSecret: z.string().min(1, "LINKEDIN_CLIENT_SECRET es requerido"),
  linkedinRedirectUri: z.string().url("LINKEDIN_REDIRECT_URI debe ser una URL válida"),
  linkedinAccessToken: z.string().optional(),
  linkedinRefreshToken: z.string().optional(),

  // ── App ─────────────────────────────────────────────────────────────────────
  scoreThreshold: z.coerce.number().min(0).max(100).default(75),
  dryRun: z.string().transform((v) => v === "true").default("false"),
  approvalRequired: z.string().transform((v) => v === "true").default("false"),
  newsInputPath: z.string().default("./inputs/news.json"),
  maxPostsPerRun: z.coerce.number().int().min(1).max(20).default(3),
  maxNewsAgeDays: z.coerce.number().int().min(1).default(30),

  // ── Scoring weights (deben sumar ≤ 100) ────────────────────────────────────
  scoreWeightRecency: z.coerce.number().min(0).default(30),
  scoreWeightTags: z.coerce.number().min(0).default(30),
  scoreWeightSource: z.coerce.number().min(0).default(20),
  scoreWeightLength: z.coerce.number().min(0).default(10),
  scoreWeightBonus: z.coerce.number().min(0).default(5),
  scorePenaltyMaxPoints: z.coerce.number().min(0).default(15),

  // ── Copy ────────────────────────────────────────────────────────────────────
  maxPostChars: z.coerce.number().int().min(100).max(3000).default(3000),
  maxHashtags: z.coerce.number().int().min(1).max(10).default(4),
  copyMinChars: z.coerce.number().int().min(50).default(200),
  copyPhraseOverlapThreshold: z.coerce.number().min(0).max(1).default(0.55),
  recentPostsToCheck: z.coerce.number().int().min(0).default(10),

  // ── Database ─────────────────────────────────────────────────────────────────
  dbPath: z.string().default("./data/linkedin_automation.db"),
  lockMaxAgeMinutes: z.coerce.number().int().min(1).default(30),

  // ── Scheduler ────────────────────────────────────────────────────────────────
  cronSchedule: z.string().default("0 9 * * *"),

  // ── Logs ─────────────────────────────────────────────────────────────────────
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),
  logDir: z.string().default("./logs"),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const raw = {
    linkedinClientId: process.env.LINKEDIN_CLIENT_ID,
    linkedinClientSecret: process.env.LINKEDIN_CLIENT_SECRET,
    linkedinRedirectUri: process.env.LINKEDIN_REDIRECT_URI ?? "http://localhost:3000/callback",
    linkedinAccessToken: process.env.LINKEDIN_ACCESS_TOKEN,
    linkedinRefreshToken: process.env.LINKEDIN_REFRESH_TOKEN,
    scoreThreshold: process.env.SCORE_THRESHOLD,
    dryRun: process.env.DRY_RUN,
    approvalRequired: process.env.APPROVAL_REQUIRED,
    newsInputPath: process.env.NEWS_INPUT_PATH,
    maxPostsPerRun: process.env.MAX_POSTS_PER_RUN,
    maxNewsAgeDays: process.env.MAX_NEWS_AGE_DAYS,
    scoreWeightRecency: process.env.SCORE_WEIGHT_RECENCY,
    scoreWeightTags: process.env.SCORE_WEIGHT_TAGS,
    scoreWeightSource: process.env.SCORE_WEIGHT_SOURCE,
    scoreWeightLength: process.env.SCORE_WEIGHT_LENGTH,
    scoreWeightBonus: process.env.SCORE_WEIGHT_BONUS,
    scorePenaltyMaxPoints: process.env.SCORE_PENALTY_MAX_POINTS,
    maxPostChars: process.env.MAX_POST_CHARS,
    maxHashtags: process.env.MAX_HASHTAGS,
    copyMinChars: process.env.COPY_MIN_CHARS,
    copyPhraseOverlapThreshold: process.env.COPY_PHRASE_OVERLAP_THRESHOLD,
    recentPostsToCheck: process.env.RECENT_POSTS_TO_CHECK,
    dbPath: process.env.DB_PATH,
    lockMaxAgeMinutes: process.env.LOCK_MAX_AGE_MINUTES,
    cronSchedule: process.env.CRON_SCHEDULE,
    logLevel: process.env.LOG_LEVEL,
    logDir: process.env.LOG_DIR,
  };

  const parsed = ConfigSchema.safeParse(raw);

  if (!parsed.success) {
    const errors = parsed.error.errors.map((e) => `  ${e.path.join(".")}: ${e.message}`);
    throw new Error(`Configuración inválida:\n${errors.join("\n")}`);
  }

  // Resolver rutas relativas desde el directorio raíz del proyecto
  const cfg = parsed.data;
  const root = path.resolve(__dirname, "../../");
  cfg.newsInputPath = path.resolve(root, cfg.newsInputPath);
  cfg.dbPath = path.resolve(root, cfg.dbPath);
  cfg.logDir = path.resolve(root, cfg.logDir);

  return cfg;
}

export const config = loadConfig();
