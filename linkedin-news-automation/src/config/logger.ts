import * as winston from "winston";
import * as path from "path";
import * as fs from "fs";
import { config } from "./index";

// Asegurar que el directorio de logs existe
if (!fs.existsSync(config.logDir)) {
  fs.mkdirSync(config.logDir, { recursive: true });
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    return `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}${metaStr}`;
  })
);

export const logger = winston.createLogger({
  level: config.logLevel,
  format: logFormat,
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), logFormat),
    }),
    new winston.transports.File({
      filename: path.join(config.logDir, "error.log"),
      level: "error",
    }),
    new winston.transports.File({
      filename: path.join(config.logDir, "combined.log"),
    }),
  ],
});
