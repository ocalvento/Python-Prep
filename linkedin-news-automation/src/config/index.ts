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

  // ── BOIA — fuente de datos ─────────────────────────────────────────────────
  /** json | api | db */
  boiaSource: z.enum(["json", "api", "db"]).default("json"),
  boiaJsonPath: z.string().default("./inputs/boia_candidates.json"),
  boiaApiUrl: z.string().optional(),
  boiaApiKey: z.string().optional(),
  boiaApiLimit: z.coerce.number().int().min(1).max(200).default(50),
  boiaDbPath: z.string().optional(),
  boiaDbTable: z.string().default("candidates"),

  // ── Filtros ───────────────────────────────────────────────────────────────
  /** Score mínimo que BOIA asignó (0-100). BOIA es la fuente de verdad de relevancia jurídica */
  boiaMinRelevance: z.coerce.number().min(0).max(100).default(70),
  /** Score editorial mínimo para publicar en LinkedIn (0-100) */
  linkedinMinScore: z.coerce.number().min(0).max(100).default(60),
  /** Máximo de posts del mismo organismo por corrida. 2do item del mismo org solo si score >= linkedinExceptionalScore */
  linkedinSameOrganismMax: z.coerce.number().int().min(1).default(1),
  /** Score que exime del throttle por organismo */
  linkedinExceptionalScore: z.coerce.number().min(0).max(100).default(90),

  // ── Control operativo ─────────────────────────────────────────────────────
  dryRun: z.string().transform((v) => v === "true").default("false"),
  approvalRequired: z.string().transform((v) => v === "true").default("false"),
  maxPostsPerRun: z.coerce.number().int().min(1).max(20).default(3),
  maxNewsAgeDays: z.coerce.number().int().min(1).default(30),

  // ── Scoring editorial (pesos del linkedinPublishScore) ───────────────────
  scorePenaltyMaxPoints: z.coerce.number().min(0).default(15),

  // ── Copy ─────────────────────────────────────────────────────────────────
  maxPostChars: z.coerce.number().int().min(100).max(3000).default(3000),
  maxHashtags: z.coerce.number().int().min(1).max(10).default(4),
  copyMinChars: z.coerce.number().int().min(50).default(200),
  copyPhraseOverlapThreshold: z.coerce.number().min(0).max(1).default(0.55),
  recentPostsToCheck: z.coerce.number().int().min(0).default(10),

  // ── Base de datos ─────────────────────────────────────────────────────────
  dbPath: z.string().default("./data/linkedin_automation.db"),
  lockMaxAgeMinutes: z.coerce.number().int().min(1).default(30),

  // ── Scheduler ─────────────────────────────────────────────────────────────
  cronSchedule: z.string().default("0 9 * * *"),

  // ── Logs ──────────────────────────────────────────────────────────────────
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
    boiaSource: process.env.BOIA_SOURCE,
    boiaJsonPath: process.env.BOIA_JSON_PATH,
    boiaApiUrl: process.env.BOIA_API_URL,
    boiaApiKey: process.env.BOIA_API_KEY,
    boiaApiLimit: process.env.BOIA_API_LIMIT,
    boiaDbPath: process.env.BOIA_DB_PATH,
    boiaDbTable: process.env.BOIA_DB_TABLE,
    boiaMinRelevance: process.env.BOIA_MIN_RELEVANCE,
    linkedinMinScore: process.env.LINKEDIN_MIN_SCORE,
    linkedinSameOrganismMax: process.env.LINKEDIN_SAME_ORGANISM_MAX,
    linkedinExceptionalScore: process.env.LINKEDIN_EXCEPTIONAL_SCORE,
    dryRun: process.env.DRY_RUN,
    approvalRequired: process.env.APPROVAL_REQUIRED,
    maxPostsPerRun: process.env.MAX_POSTS_PER_RUN,
    maxNewsAgeDays: process.env.MAX_NEWS_AGE_DAYS,
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

  const cfg = parsed.data;
  const root = path.resolve(__dirname, "../../");
  cfg.boiaJsonPath = path.resolve(root, cfg.boiaJsonPath);
  cfg.dbPath = path.resolve(root, cfg.dbPath);
  cfg.logDir = path.resolve(root, cfg.logDir);
  if (cfg.boiaDbPath) cfg.boiaDbPath = path.resolve(root, cfg.boiaDbPath);

  return cfg;
}

export const config = loadConfig();
