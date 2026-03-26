import "dotenv/config";
import * as cron from "node-cron";
import { runPublishJob } from "./publish";
import { config } from "../config";
import { logger } from "../config/logger";

/**
 * Inicia el scheduler que ejecuta el job de publicación según CRON_SCHEDULE.
 *
 * El lock en DB garantiza que dos instancias del scheduler (ej. dos cron processes
 * solapados) no publiquen simultáneamente el mismo contenido.
 */
function startScheduler(): void {
  const schedule = config.cronSchedule;

  if (!cron.validate(schedule)) {
    logger.error("Expresión cron inválida", { schedule });
    process.exit(1);
  }

  logger.info("Scheduler iniciado", {
    schedule,
    dryRun: config.dryRun,
    approvalRequired: config.approvalRequired,
    threshold: config.scoreThreshold,
    maxPostsPerRun: config.maxPostsPerRun,
  });

  cron.schedule(schedule, async () => {
    logger.info("Ejecutando job programado...", { schedule });
    try {
      const result = await runPublishJob();
      logger.info("Job programado completado", result);
    } catch (error) {
      logger.error("Error en job programado", { error: String(error) });
    }
  });

  // Manejo limpio de señales — no ejecutar al inicio (a diferencia de la v1)
  // para evitar doble publicación al reiniciar el proceso
  process.on("SIGTERM", () => {
    logger.info("SIGTERM recibido, cerrando scheduler...");
    process.exit(0);
  });

  process.on("SIGINT", () => {
    logger.info("SIGINT recibido, cerrando scheduler...");
    process.exit(0);
  });
}

startScheduler();
