import * as dotenv from "dotenv";
import { z } from "zod";
import * as path from "path";

dotenv.config();

const ConfigSchema = z.object({
  // LinkedIn OAuth
  linkedinClientId: z.string().min(1, "LINKEDIN_CLIENT_ID es requerido"),
  linkedinClientSecret: z.string().min(1, "LINKEDIN_CLIENT_SECRET es requerido"),
  linkedinRedirectUri: z.string().url("LINKEDIN_REDIRECT_URI debe ser una URL válida"),
  linkedinAccessToken: z.string().optional(),
  linkedinRefreshToken: z.string().optional(),

  // App
  scoreThreshold: z.coerce.number().min(0).max(100).default(75),
  dryRun: z
    .string()
    .transform((v) => v === "true")
    .default("false"),
  newsInputPath: z.string().default("./inputs/news.json"),

  // Database
  dbPath: z.string().default("./data/linkedin_automation.db"),

  // Scheduler
  cronSchedule: z.string().default("0 9 * * *"),

  // Logs
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),
  logDir: z.string().default("./logs"),
});

type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const raw = {
    linkedinClientId: process.env.LINKEDIN_CLIENT_ID,
    linkedinClientSecret: process.env.LINKEDIN_CLIENT_SECRET,
    linkedinRedirectUri: process.env.LINKEDIN_REDIRECT_URI ?? "http://localhost:3000/callback",
    linkedinAccessToken: process.env.LINKEDIN_ACCESS_TOKEN,
    linkedinRefreshToken: process.env.LINKEDIN_REFRESH_TOKEN,
    scoreThreshold: process.env.SCORE_THRESHOLD,
    dryRun: process.env.DRY_RUN,
    newsInputPath: process.env.NEWS_INPUT_PATH,
    dbPath: process.env.DB_PATH,
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
  const config = parsed.data;
  const root = path.resolve(__dirname, "../../");
  config.newsInputPath = path.resolve(root, config.newsInputPath);
  config.dbPath = path.resolve(root, config.dbPath);
  config.logDir = path.resolve(root, config.logDir);

  return config;
}

export const config = loadConfig();
export type { Config };
