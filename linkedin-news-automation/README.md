# LinkedIn News Automation

Sistema de publicación automatizada en LinkedIn. Lee noticias desde un archivo JSON, evalúa su relevancia, genera posts profesionales en español y los publica vía la API oficial de LinkedIn.

---

## Arquitectura

```
inputs/news.json
    │
    ▼
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   ingest    │────▶│   scoring    │────▶│     copy     │
│ Lee y valida│     │ Score 0-100  │     │ Genera post  │
│  con Zod    │     │ por señales  │     │ en español   │
└─────────────┘     └──────────────┘     └──────┬───────┘
                                                │
                         score < 75 → SKIP      │
                         ya publicado → SKIP    ▼
                                         ┌──────────────┐
                                         │   linkedin   │
                                         │ POST /rest/  │
                                         │    posts     │
                                         └──────┬───────┘
                                                │
                                                ▼
                                         ┌──────────────┐
                                         │      db      │
                                         │   SQLite     │
                                         │  persiste    │
                                         └──────────────┘

auth/tokenManager ──▶ SQLite (tokens) ◀── scripts/getToken.ts
```

### Módulos

| Módulo | Responsabilidad |
|---|---|
| `src/config` | Variables de entorno + logger |
| `src/ingest` | Leer y validar `news.json` con Zod |
| `src/scoring` | Score 0-100 por recencia, tags, fuente, datos |
| `src/copy` | Generar texto del post en español profesional |
| `src/linkedin` | Cliente HTTP LinkedIn API con retry y token refresh |
| `src/auth` | OAuth 2.0, exchange code, refresh token |
| `src/db` | SQLite: posts + tokens, deduplicación por SHA-256 |
| `src/jobs` | Orquestación: publish, dryRun, scheduler |
| `scripts` | Herramienta interactiva para obtener tokens |

---

## Requisitos previos

- Node.js >= 18
- npm >= 9
- Una **LinkedIn Developer App** con el scope `w_member_social` habilitado

---

## 1. Obtener credenciales de LinkedIn

### 1.1 Crear la app en LinkedIn

1. Ir a [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps)
2. Crear una nueva app
3. En **Products**, solicitar acceso a **Share on LinkedIn** (habilita `w_member_social`)
4. En **Auth**, agregar la URL de redirección: `http://localhost:3000/callback`
5. Copiar el **Client ID** y el **Client Secret**

> **Nota sobre scopes**: Para publicar posts se necesita `w_member_social`. Para obtener el person URN se usa `openid profile`. El scope `r_emailaddress` es opcional.

### 1.2 Scopes necesarios

```
openid profile w_member_social
```

---

## 2. Instalación

```bash
# Clonar / navegar al directorio
cd linkedin-news-automation

# Instalar dependencias
npm install

# Copiar el archivo de configuración
cp .env.example .env
```

### 2.1 Configurar `.env`

```env
LINKEDIN_CLIENT_ID=tu_client_id
LINKEDIN_CLIENT_SECRET=tu_client_secret
LINKEDIN_REDIRECT_URI=http://localhost:3000/callback
SCORE_THRESHOLD=75
DRY_RUN=false
```

---

## 3. Autenticación inicial (OAuth 2.0)

Solo necesitás hacer esto **una vez**. Los tokens se guardan en SQLite y se refrescan automáticamente.

```bash
npm run get-token
```

El script:
1. Inicia un servidor HTTP local en el puerto 3000
2. Imprime la URL de autorización de LinkedIn
3. Abrís la URL en el navegador y autorizás la app
4. Captura el authorization code del redirect
5. Intercambia el code por access + refresh tokens
6. Guarda los tokens en la base de datos

**Output esperado:**

```
══════════════════════════════════════════════════════════════════════
  AUTENTICACIÓN OAUTH 2.0 — LINKEDIN
══════════════════════════════════════════════════════════════════════

  Abrí la siguiente URL en tu navegador para autorizar la app:

  https://www.linkedin.com/oauth/v2/authorization?response_type=code&...

  Esperando el callback...

══════════════════════════════════════════════════════════════════════
  TOKENS OBTENIDOS EXITOSAMENTE
══════════════════════════════════════════════════════════════════════
  Scope        : openid profile w_member_social
  Expira en    : 60 días
  Refresh token: Sí
```

---

## 4. Agregar noticias

Editar `inputs/news.json` con el formato:

```json
[
  {
    "title": "Título de la noticia",
    "summary": "Resumen descriptivo de al menos 20 caracteres con información relevante.",
    "url": "https://fuente.com/articulo",
    "source": "Nombre de la fuente",
    "published_at": "2026-03-24T14:30:00Z",
    "tags": ["ia", "tecnología", "innovación"]
  }
]
```

### Campos requeridos

| Campo | Tipo | Descripción |
|---|---|---|
| `title` | string | Título (mín. 5 chars) |
| `summary` | string | Resumen (mín. 20 chars) |
| `url` | string | URL válida del artículo |
| `source` | string | Nombre de la fuente |
| `published_at` | string | Fecha ISO 8601 |
| `tags` | string[] | Al menos 1 tag |

---

## 5. Comandos

### Dry-run (recomendado antes de publicar)

Simula el pipeline completo sin publicar nada. Muestra qué posts se generarían y sus scores.

```bash
npm run dry-run
```

**Output:**

```
══════════════════════════════════════════════════════════════════════
  DRY RUN — REPORTE DE PUBLICACIONES
══════════════════════════════════════════════════════════════════════
  Total noticias procesadas : 7
  Se publicarían            : 4
  Saltadas (score bajo)     : 2
  Saltadas (duplicado)      : 1
══════════════════════════════════════════════════════════════════════

  ── POST 1 / 4 ─────────────────────────────────────────────────
  Título  : OpenAI lanza GPT-5 con capacidades...
  Score   : 91/100
  Breakdown: recency=29 tags=30 source=12 length=10 bonus=10
  Chars   : 642
  Tags    : #ia #machinelearning #tecnologia #innovacion

  TEXTO DEL POST:
  OpenAI lanza GPT-5 con capacidades avanzadas de razonamiento

  El modelo supera a su predecesor en un 40% en benchmarks...
  ...
```

### Publicar ahora

```bash
npm run publish-now
```

### Scheduler (cron diario)

```bash
npm run schedule
```

Ejecuta el pipeline según `CRON_SCHEDULE` (default: `0 9 * * *` → 9 AM todos los días).

### Tests

```bash
npm test
# Con cobertura
npm test -- --coverage
```

---

## 6. Sistema de scoring

Cada noticia recibe un score 0-100 basado en:

| Señal | Puntos | Descripción |
|---|---|---|
| Recencia | 0-30 | Decaimiento exponencial. Hoy = 30 pts, 1 semana ≈ 5 pts |
| Tags relevantes | 0-35 | Tags de alto valor (ia, startup, liderazgo) = 10 pts c/u; medio valor = 5 pts |
| Credibilidad de fuente | 0-20 | Fuentes verificadas (HBR, TechCrunch, Wired...) = 20 pts; desconocida = 5 pts |
| Longitud del resumen | 0-10 | Resumen con ≥ 80 palabras = 10 pts |
| Bonus | 0-5 | Datos numéricos (%), montos, citas de estudios/informes |

**Publicación**: Solo si `score >= SCORE_THRESHOLD` (default: 75).

---

## 7. Generación de copy

El post generado sigue esta estructura:

```
[Título de la noticia]

[Dato destacado si hay %/$ en el resumen.] Según [fuente], [resumen]

[Reflexión contextual según los tags]

[CTA suave rotativo]

#hashtag1 #hashtag2 #hashtag3 #hashtag4
```

**Reglas:**
- Máximo 3.000 caracteres (límite LinkedIn)
- Máximo 4 hashtags
- Tono profesional sin exageraciones
- No se inventan datos (solo se usa lo que viene en `summary`)
- La reflexión varía según los tags (IA, liderazgo, fintech, etc.)

---

## 8. Base de datos SQLite

El archivo se crea en `./data/linkedin_automation.db`.

### Tabla `posts`

```sql
CREATE TABLE posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash  TEXT    NOT NULL UNIQUE,  -- SHA-256(title + url)
  title         TEXT    NOT NULL,
  source_url    TEXT    NOT NULL,
  score         INTEGER NOT NULL,
  status        TEXT    NOT NULL,         -- published | skipped | failed | dry_run
  linkedin_urn  TEXT,                     -- urn:li:share:{id}
  post_text     TEXT,
  error_message TEXT,
  created_at    DATETIME DEFAULT (datetime('now')),
  published_at  DATETIME
);
```

### Tabla `tokens`

```sql
CREATE TABLE tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  access_token  TEXT    NOT NULL,
  refresh_token TEXT,
  expires_at    DATETIME NOT NULL,
  scope         TEXT,
  updated_at    DATETIME DEFAULT (datetime('now'))
);
```

---

## 9. Manejo de tokens y errores

### Flujo de tokens

```
getValidAccessToken()
    │
    ├─ ENV var LINKEDIN_ACCESS_TOKEN → usar directamente
    │
    ├─ SQLite: token no vencido → usar
    │
    ├─ SQLite: token vencido + refresh_token → refreshAccessToken()
    │                                              │
    │                                              └─ Guardar nuevo token en DB
    │
    └─ Sin token → Error → ejecutar `npm run get-token`
```

### Flujo de publicación ante error 401

```
publishPost()
    │
    ├─ Request exitoso → guardar URN → ✓
    │
    ├─ Error 401 + primer intento → refreshAccessToken() → reintentar UNA vez
    │                               │
    │                               ├─ Éxito → guardar URN → ✓
    │                               └─ Error → registrar en DB como failed → salir
    │
    └─ Otro error (4xx/5xx) → registrar en DB como failed → continuar con siguiente
```

### Retries automáticos

`axios-retry` está configurado para reintentar en:
- Errores de red
- HTTP 429 (rate limit)
- HTTP 5xx (errores de servidor)

Con backoff exponencial (1s, 2s, 4s) hasta 3 intentos.

---

## 10. Estructura del proyecto

```
linkedin-news-automation/
├── src/
│   ├── auth/
│   │   └── tokenManager.ts     # OAuth 2.0: exchange, refresh, build URL
│   ├── linkedin/
│   │   └── client.ts           # HTTP client LinkedIn API + retry + token refresh
│   ├── ingest/
│   │   └── newsReader.ts       # Lee y valida news.json con Zod + computa hash
│   ├── scoring/
│   │   └── scorer.ts           # Score 0-100 por recencia, tags, fuente, datos
│   ├── copy/
│   │   └── generator.ts        # Genera post en español profesional
│   ├── db/
│   │   └── index.ts            # SQLite: schema, posts, tokens, dedup
│   ├── jobs/
│   │   ├── publish.ts          # Pipeline completo
│   │   ├── dryRun.ts           # Simulación sin publicar
│   │   └── scheduler.ts        # Cron job
│   └── config/
│       ├── index.ts            # Carga y valida variables de entorno
│       └── logger.ts           # Winston logger (consola + archivo)
├── inputs/
│   └── news.json               # Feed de noticias de entrada
├── scripts/
│   └── getToken.ts             # Flujo OAuth interactivo
├── tests/
│   ├── scoring.test.ts
│   ├── copy.test.ts
│   └── ingest.test.ts
├── data/                       # Generado: LinkedIn.db
├── logs/                       # Generado: combined.log, error.log
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## 11. Variables de entorno

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `LINKEDIN_CLIENT_ID` | Sí | — | Client ID de la app de LinkedIn |
| `LINKEDIN_CLIENT_SECRET` | Sí | — | Client Secret de la app de LinkedIn |
| `LINKEDIN_REDIRECT_URI` | No | `http://localhost:3000/callback` | URL de redirección OAuth |
| `LINKEDIN_ACCESS_TOKEN` | No | — | Token manual (override, útil en CI) |
| `LINKEDIN_REFRESH_TOKEN` | No | — | Refresh token manual (override) |
| `SCORE_THRESHOLD` | No | `75` | Score mínimo para publicar (0-100) |
| `DRY_RUN` | No | `false` | Si `true`, no publica en LinkedIn |
| `NEWS_INPUT_PATH` | No | `./inputs/news.json` | Ruta al archivo de noticias |
| `DB_PATH` | No | `./data/linkedin_automation.db` | Ruta a la base de datos SQLite |
| `CRON_SCHEDULE` | No | `0 9 * * *` | Expresión cron del scheduler |
| `LOG_LEVEL` | No | `info` | Nivel de logs (error/warn/info/debug) |
| `LOG_DIR` | No | `./logs` | Directorio de archivos de log |

---

## 12. Ejemplo de request a LinkedIn

### POST /rest/posts

```http
POST https://api.linkedin.com/rest/posts
Authorization: Bearer {ACCESS_TOKEN}
Content-Type: application/json
LinkedIn-Version: 202406
X-Restli-Protocol-Version: 2.0.0

{
  "author": "urn:li:person:ABC123XYZ",
  "commentary": "OpenAI lanza GPT-5 con capacidades avanzadas...\n\n...\n\n#ia #machinelearning",
  "visibility": "PUBLIC",
  "distribution": {
    "feedDistribution": "MAIN_FEED",
    "targetEntities": [],
    "thirdPartyDistributionChannels": []
  },
  "lifecycleState": "PUBLISHED",
  "isReshareDisabledByAuthor": false
}
```

**Respuesta exitosa:**

```http
HTTP/1.1 201 Created
x-restli-id: urn:li:share:7234567890123456789
```

### GET /v2/userinfo (obtener person URN)

```http
GET https://api.linkedin.com/v2/userinfo
Authorization: Bearer {ACCESS_TOKEN}

{
  "sub": "ABC123XYZ",
  "name": "Juan Pérez",
  "given_name": "Juan",
  "family_name": "Pérez"
}
```

---

## Solución de problemas

**"No hay access token disponible"**
→ Ejecutar `npm run get-token`

**Error 401 al publicar**
→ El token venció y no hay refresh token. Re-autenticarse con `npm run get-token`

**Error 403 al publicar**
→ La app no tiene el scope `w_member_social`. Verificar en el Developer Portal que el producto "Share on LinkedIn" está activo.

**Score siempre bajo**
→ Verificar que los `tags` en `news.json` coincidan con los valores en `HIGH_VALUE_TAGS` del scorer. Los tags son case-insensitive.

**"Archivo de noticias no encontrado"**
→ Verificar que `NEWS_INPUT_PATH` apunta al archivo correcto, o que `inputs/news.json` existe en la raíz del proyecto.
