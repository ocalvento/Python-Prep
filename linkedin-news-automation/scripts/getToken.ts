/**
 * Script interactivo para obtener tokens OAuth 2.0 de LinkedIn.
 *
 * Flujo:
 *   1. Inicia un servidor HTTP local en el puerto 3000
 *   2. Abre (o muestra) la URL de autorización de LinkedIn
 *   3. Captura el authorization code del redirect
 *   4. Intercambia el code por access + refresh tokens
 *   5. Guarda los tokens en la base de datos
 *
 * Uso: npm run get-token
 */

import "dotenv/config";
import * as http from "http";
import * as crypto from "crypto";
import { buildAuthorizationUrl, exchangeCodeForTokens } from "../src/auth/tokenManager";
import { logger } from "../src/config/logger";

const PORT = 3000;
const CALLBACK_PATH = "/callback";

async function main(): Promise<void> {
  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = buildAuthorizationUrl(state);

  console.log("\n" + "═".repeat(70));
  console.log("  AUTENTICACIÓN OAUTH 2.0 — LINKEDIN");
  console.log("═".repeat(70));
  console.log("\n  Abrí la siguiente URL en tu navegador para autorizar la app:\n");
  console.log(`  ${authUrl}`);
  console.log(
    "\n  Asegurate de que la URL de callback configurada en tu app de LinkedIn sea:"
  );
  console.log(`  http://localhost:${PORT}${CALLBACK_PATH}`);
  console.log("\n  Esperando el callback...\n");

  await waitForCallback(state);
}

function waitForCallback(expectedState: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith(CALLBACK_PATH)) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      const url = new URL(req.url, `http://localhost:${PORT}`);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");

      if (error) {
        const msg = `Error de autorización: ${error} — ${errorDescription}`;
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h1>Error</h1><p>${msg}</p>`);
        server.close();
        reject(new Error(msg));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>Error</h1><p>No se recibió el authorization code.</p>");
        server.close();
        reject(new Error("No se recibió el authorization code"));
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>Error</h1><p>State inválido. Posible ataque CSRF.</p>");
        server.close();
        reject(new Error("State inválido"));
        return;
      }

      try {
        console.log("  Código recibido. Intercambiando por tokens...");
        const tokens = await exchangeCodeForTokens(code);

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
          <h1 style="color:green">¡Autenticación exitosa!</h1>
          <p>Tokens guardados en la base de datos.</p>
          <p>Scope: <code>${tokens.scope}</code></p>
          <p>El access token expira en <strong>${Math.round(tokens.expires_in / 3600)} horas</strong>.</p>
          <p>Podés cerrar esta ventana y volver a la terminal.</p>
        `);

        console.log("\n" + "═".repeat(70));
        console.log("  TOKENS OBTENIDOS EXITOSAMENTE");
        console.log("═".repeat(70));
        console.log(`  Scope        : ${tokens.scope}`);
        console.log(`  Expira en    : ${Math.round(tokens.expires_in / 3600)} horas`);
        console.log(`  Refresh token: ${tokens.refresh_token ? "Sí" : "No"}`);
        console.log("\n  Los tokens fueron guardados en la base de datos.");
        console.log("  Ya podés ejecutar: npm run publish-now\n");

        server.close();
        resolve();
      } catch (err) {
        const msg = `Error al intercambiar tokens: ${String(err)}`;
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h1>Error</h1><p>${msg}</p>`);
        server.close();
        reject(new Error(msg));
      }
    });

    server.listen(PORT, () => {
      logger.debug(`Servidor de callback escuchando en puerto ${PORT}`);
    });

    server.on("error", (err) => {
      reject(new Error(`No se pudo iniciar el servidor en puerto ${PORT}: ${err.message}`));
    });

    // Timeout de 5 minutos
    setTimeout(() => {
      server.close();
      reject(new Error("Timeout: no se recibió el callback en 5 minutos"));
    }, 5 * 60 * 1000);
  });
}

main().catch((err) => {
  console.error("\n  ERROR:", err.message);
  process.exit(1);
});
