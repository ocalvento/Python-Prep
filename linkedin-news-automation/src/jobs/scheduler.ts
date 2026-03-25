import "dotenv/config";
import * as cron from "node-cron";
import { runPublishJob } from "./publish";
import { config } from "../config";
import { logger } from "../config/logger";

/**
 * Inicia el scheduler que ejecuta el job de publicación
 * según la expresión cron configurada en CRON_SCHEDULE.
 *
 * Default: 0 9 * * *  →  todos los días a las 9:00 AM
 */
function startScheduler(): void {
  const schedule = config.cronSchedule;

  if (!cron.validate(schedule)) {
    logger.error("Expresión cron inválida", { schedule });
    process.exit(1);
  }

  logger.info("Scheduler iniciado", { schedule });

  cron.schedule(schedule, async () => {
    logger.info("Ejecutando job programado...");
    try {
      const result = await runPublishJob();
      logger.info("Job programado completado", result);
    } catch (error) {
      logger.error("Error en job programado", { error: String(error) });
    }
  });

  // También ejecutar una vez al inicio para verificar que todo funciona
  logger.info("Ejecutando primera corrida inmediata para verificación...");
  runPublishJob()
    .then((result) => {
      logger.info("Primera corrida completada", result);
    })
    .catch((err) => {
      logger.error("Error en primera corrida", { error: String(err) });
    });

  // Manejo limpio de señales
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
