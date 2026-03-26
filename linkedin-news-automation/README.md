# LinkedIn News Automation

Sistema de publicación automatizada en LinkedIn. Lee noticias desde un archivo JSON, evalúa su relevancia, genera posts profesionales en español y los publica vía la API oficial de LinkedIn con garantías de seguridad, deduplicación y control editorial.

---

## Arquitectura

```
inputs/news.json
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│  ingest — Lee, valida (Zod), normaliza, deduplica         │
│  · Normaliza title/source/tags a lowercase                │
│  · Elimina tracking params de URLs (utm_*, fbclid, etc.) │
│  · Soporta canonical_url para dedup canónica              │
│  · Rechaza fechas futuras o más viejas de N días          │
└────────────────────────────┬─────────────────────────────┘
                             ▼
┌──────────────────────────────────────────────────────────┐
│  scoring — Score 0-100 con 5 señales configurables        │
│  · Recencia (decaimiento exponencial, half-life 48h)      │
│  · Tags (retornos decrecientes, high/medium value)        │
│  · Credibilidad de fuente (20 fuentes verificadas)        │
│  · Longitud del resumen                                   │
│  · Bonus (datos %, montos, citas de estudios)             │
│  · Penalización (frases genéricas, título corto, sin tags)│
└────────────────────────────┬─────────────────────────────┘
                             │ score < SCORE_THRESHOLD → SKIP
                             ▼
┌──────────────────────────────────────────────────────────┐
│  copy — Genera texto en español profesional               │
│  · Extrae datos numéricos y los destaca                   │
│  · Reflexión contextual con múltiples variantes por tema  │
│  · Detecta overlap de bigramas con posts recientes        │
│  · Valida calidad mínima (quality score ≥ 40)             │
│  · Devuelve { ok: false } si el copy es débil             │
└────────────────────────────┬─────────────────────────────┘
                             │ copy débil → SKIP
                             ▼
┌──────────────────────────────────────────────────────────┐
│  db — isAlreadyProcessed() — SHA-256(title+url)           │
└────────────────────────────┬─────────────────────────────┘
                             │ duplicado → SKIP
                             ▼
┌──────────────────────────────────────────────────────────┐
│  linkedin/client — POST /rest/posts                       │
│  · Errores tipados: auth / scope / rate_limit / validation│
│  · Refresh token automático si 401 (una sola vez)         │
│  · No reintenta en 400/403/422                            │
│  · axios-retry en 429/5xx con backoff exponencial         │
└────────────────────────────┬─────────────────────────────┘
                             ▼
┌──────────────────────────────────────────────────────────┐
│  db — savePost() con: URN, post_id, score_breakdown,      │
│  copy_text, failure_reason, published_at_real             │
└──────────────────────────────────────────────────────────┘

auth/tokenManager ──▶ SQLite (tokens) ◀── scripts/getToken.ts
jobs/publish.ts   ──▶ lock DB ──▶ pipeline completo
jobs/dryRun.ts    ──▶ simulación solo-lectura (sin escribir en DB)
```

### Módulos

| Módulo | Responsabilidad |
|---|---|
| `src/config` | Variables de entorno validadas con Zod + logger |
| `src/ingest` | Leer, validar, normalizar y deduplicar news.json |
| `src/scoring` | Score 0-100 con pesos configurables + penalidades |
| `src/copy` | Generar texto profesional con validación de calidad y overlap |
| `src/linkedin` | Cliente HTTP con errores tipados y refresh de token |
| `src/auth` | OAuth 2.0: exchange code, refresh token |
| `src/db` | SQLite con migraciones, dedup, lock de concurrencia |
| `src/jobs` | Orquestación: publish (con lock), dryRun, scheduler |
| `scripts` | Flujo OAuth interactivo para obtener tokens |

---

## Requisitos previos

- Node.js >= 18
- npm >= 9
- Una **LinkedIn Developer App** con el producto **Share on LinkedIn** activo

---

## 1. Crear app en LinkedIn Developer Portal

1. Ir a [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps) → **Create App**
2. En la pestaña **Products**, solicitar **Share on LinkedIn** (habilita `w_member_social`)
3. En **Auth** → **OAuth 2.0 settings**, agregar la URL de redirección:
   ```
   http://localhost:3000/callback
   ```
4. Copiar el **Client ID** y el **Client Secret**

> **Scopes necesarios:** `openid profile w_member_social`

---

## 2. Instalación

```bash
# Clonar / navegar al directorio
cd linkedin-news-automation

# Instalar dependencias
npm install

# Copiar configuración
cp .env.example .env
# Editar .env con tus credenciales
```

---

## 3. Configuración (`.env`)

```env
LINKEDIN_CLIENT_ID=tu_client_id
LINKEDIN_CLIENT_SECRET=tu_client_secret
LINKEDIN_REDIRECT_URI=http://localhost:3000/callback
SCORE_THRESHOLD=75
MAX_POSTS_PER_RUN=3
DRY_RUN=false
APPROVAL_REQUIRED=false
```

Ver `.env.example` para la lista completa de variables.

---

## 4. Autenticación inicial (OAuth 2.0 — una sola vez)

```bash
npm run get-token
```

El script:
1. Muestra una URL de autorización de LinkedIn en la terminal
2. Abrís la URL en el navegador y autorizás la app
3. Captura el `authorization_code` en el redirect a `localhost:3000/callback`
4. Intercambia el code por `access_token` + `refresh_token`
5. Guarda los tokens en SQLite (se refrescan automáticamente)

**Output esperado:**
```
  Abrí la siguiente URL en tu navegador:
  https://www.linkedin.com/oauth/v2/authorization?...

  TOKENS OBTENIDOS EXITOSAMENTE
  Scope    : openid profile w_member_social
  Expira en: 60 días
  Refresh  : Sí
```

---

## 5. Agregar noticias (`inputs/news.json`)

```json
[
  {
    "title": "Título de la noticia (mín. 10 chars)",
    "summary": "Resumen descriptivo con al menos 50 caracteres y contexto suficiente.",
    "url": "https://fuente.com/articulo",
    "canonical_url": "https://fuente.com/articulo-canonico",
    "source": "Nombre de la fuente",
    "published_at": "2026-03-24T14:30:00Z",
    "tags": ["ia", "tecnología", "innovación"]
  }
]
```

### Validaciones aplicadas en ingest

| Campo | Regla |
|---|---|
| `title` | 10-300 chars |
| `summary` | 50-5000 chars |
| `url` | URL válida |
| `canonical_url` | URL válida (opcional) |
| `source` | 2-100 chars |
| `published_at` | ISO 8601, no futuro, no más viejo que `MAX_NEWS_AGE_DAYS` |
| `tags` | 1-20 tags, máx. 50 chars c/u |

---

## 6. Comandos

### Dry-run (siempre primero)

Simula el pipeline sin publicar ni escribir en DB. Muestra scores, copy generado y razones de skip.

```bash
npm run dry-run
```

### Publicar ahora

```bash
npm run publish-now
```

### Modo de aprobación manual

```bash
# Generar posts y guardarlos como "pending_approval" (no publica)
APPROVAL_REQUIRED=true npm run publish-now

# Ver posts pendientes y publicar los aprobados
npm run publish-approved
```

### Scheduler (cron)

```bash
npm run schedule
```

Ejecuta según `CRON_SCHEDULE` (default: `0 9 * * *` → 9 AM todos los días).

### Tests

```bash
npm test                    # correr todos los tests
npm test -- --coverage      # con cobertura
npm test scoring            # solo el suite de scoring
npm test -- --verbose       # output detallado
```

---

## 7. Sistema de scoring

| Señal | Peso default | Descripción |
|---|---|---|
| `SCORE_WEIGHT_RECENCY` | 30 | Decaimiento exponencial. Half-life: 48h. Hoy = 30 pts, 1 semana ≈ 5 pts |
| `SCORE_WEIGHT_TAGS` | 30 | Retornos decrecientes. Tags de alto valor = 10 pts c/u (primer tag) |
| `SCORE_WEIGHT_SOURCE` | 20 | Fuentes verificadas (HBR, TechCrunch, Wired...) = 20 pts |
| `SCORE_WEIGHT_LENGTH` | 10 | Lineal hasta 80 palabras = 10 pts |
| `SCORE_WEIGHT_BONUS` | 5 | Datos numéricos (%), montos, citas de estudios |
| `SCORE_PENALTY_MAX_POINTS` | -15 | Penalización por frases genéricas, título corto, sin tags relevantes |

**Tags de alto valor** (configurados en `scorer.ts`):
`ia`, `machine learning`, `startup`, `fintech`, `cloud`, `liderazgo`, `product`, `innovación`, `growth`, y más.

**Publicación**: solo si `score >= SCORE_THRESHOLD` (default: 75).

---

## 8. Generación de copy

### Estructura del post

```
[Título]

[Dato numérico destacado (si existe).] [Resumen truncado a 220 chars]

[Reflexión contextual según tags — elegida con menor overlap con posts recientes]

[CTA rotativo determinista]

#hashtag1 #hashtag2 #hashtag3 #hashtag4
```

### Validación de calidad

El post es **rechazado** (`{ ok: false }`) si:
- Tiene menos de `COPY_MIN_CHARS` caracteres (default: 200)
- El quality score es < 40/100
- El overlap de bigramas con cualquier post reciente supera `COPY_PHRASE_OVERLAP_THRESHOLD` (default: 55%)

---

## 9. Manejo de errores de LinkedIn API

| HTTP | Clasificación | Comportamiento |
|---|---|---|
| 401 | `auth_error` | Refresh token → reintento único |
| 403 | `scope_error` | Falla inmediata — no hay retry |
| 400/422 | `validation_error` | Falla inmediata — payload inválido |
| 429 | `rate_limit` | axios-retry con backoff exponencial (max 3 intentos) |
| 5xx | `network_error` | axios-retry con backoff exponencial (max 3 intentos) |

Ante `auth_error` o `scope_error`, el job aborta los posts restantes de esa corrida.

---

## 10. Base de datos SQLite

Archivo: `./data/linkedin_automation.db`

### Tabla `posts`

```sql
CREATE TABLE posts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash      TEXT    NOT NULL UNIQUE,   -- SHA-256(title_norm + url_norm)
  title             TEXT    NOT NULL,
  source_url        TEXT    NOT NULL,          -- URL normalizada
  score             INTEGER NOT NULL,
  status            TEXT    NOT NULL,          -- published|skipped|failed|dry_run|pending_approval
  linkedin_urn      TEXT,                      -- urn:li:share:123456789
  linkedin_post_id  TEXT,                      -- 123456789 (extraído del URN)
  post_text         TEXT,                      -- texto del post (compatibilidad)
  copy_text         TEXT,                      -- texto del post generado
  copy_quality_score INTEGER,                  -- quality score 0-100
  error_message     TEXT,
  failure_reason    TEXT,                      -- auth_error|scope_error|rate_limit|...
  score_breakdown   TEXT,                      -- JSON con breakdown por señal
  created_at        DATETIME DEFAULT (datetime('now')),
  published_at      DATETIME,                  -- cuando se marcó como published
  published_at_real DATETIME                   -- timestamp real de publicación
);
```

### Tabla `locks`

```sql
CREATE TABLE locks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,   -- 'publish_job'
  pid        INTEGER NOT NULL,          -- PID del proceso
  started_at DATETIME DEFAULT (datetime('now'))
);
```

---

## 11. Lock de concurrencia

El job usa un lock DB-based para evitar doble publicación:

1. Al iniciar: intenta insertar en `locks` → si ya existe un lock reciente, aborta
2. Locks más viejos que `LOCK_MAX_AGE_MINUTES` (default: 30 min) se consideran stale y se eliminan automáticamente
3. Al finalizar (éxito o error): elimina el lock del proceso actual

---

## 12. Variables de entorno — referencia completa

| Variable | Default | Descripción |
|---|---|---|
| `LINKEDIN_CLIENT_ID` | — | **Requerido.** Client ID de la app |
| `LINKEDIN_CLIENT_SECRET` | — | **Requerido.** Client Secret de la app |
| `LINKEDIN_REDIRECT_URI` | `http://localhost:3000/callback` | URL de redirección OAuth |
| `LINKEDIN_ACCESS_TOKEN` | — | Token manual (override para CI/CD) |
| `LINKEDIN_REFRESH_TOKEN` | — | Refresh token manual |
| `SCORE_THRESHOLD` | `75` | Score mínimo para publicar |
| `APPROVAL_REQUIRED` | `false` | Si true, guarda como pending en lugar de publicar |
| `DRY_RUN` | `false` | Si true, simula sin publicar (no escribe en DB) |
| `MAX_POSTS_PER_RUN` | `3` | Límite de publicaciones por corrida |
| `MAX_NEWS_AGE_DAYS` | `30` | Ignorar noticias más antiguas |
| `SCORE_WEIGHT_RECENCY` | `30` | Peso de la señal de recencia |
| `SCORE_WEIGHT_TAGS` | `30` | Peso de los tags |
| `SCORE_WEIGHT_SOURCE` | `20` | Peso de la credibilidad de fuente |
| `SCORE_WEIGHT_LENGTH` | `10` | Peso de la longitud del resumen |
| `SCORE_WEIGHT_BONUS` | `5` | Peso del bonus por datos concretos |
| `SCORE_PENALTY_MAX_POINTS` | `15` | Máximo de puntos de penalización |
| `MAX_POST_CHARS` | `3000` | Límite de caracteres del post |
| `MAX_HASHTAGS` | `4` | Máximo de hashtags |
| `COPY_MIN_CHARS` | `200` | Mínimo de chars para aceptar el copy |
| `COPY_PHRASE_OVERLAP_THRESHOLD` | `0.55` | Coeficiente de Jaccard máximo con posts recientes |
| `RECENT_POSTS_TO_CHECK` | `10` | Cuántos posts recientes revisar para overlap |
| `DB_PATH` | `./data/linkedin_automation.db` | Ruta a la base de datos |
| `LOCK_MAX_AGE_MINUTES` | `30` | Minutos antes de considerar un lock como stale |
| `CRON_SCHEDULE` | `0 9 * * *` | Expresión cron del scheduler |
| `LOG_LEVEL` | `info` | Nivel de logs (error/warn/info/debug) |
| `LOG_DIR` | `./logs` | Directorio de logs |

---

## 13. Solución de problemas

### "No hay access token disponible"
```bash
npm run get-token
```

### Error 401 al publicar
El token venció y no hay refresh token. Re-autenticarse:
```bash
npm run get-token
```

### Error 403 al publicar
```
scope_error: Permisos insuficientes (403). Verificá que la app tenga w_member_social activo.
```
→ Ir al Developer Portal → Products → verificar que **Share on LinkedIn** está aprobado.

### Error 400/422 al publicar
```
validation_error: Payload inválido
```
→ El texto del post puede tener caracteres no permitidos o superar límites de LinkedIn. Revisar `copy_text` en la DB.

### "Lock de ejecución activo"
```
Lock de ejecución activo, abortando. pid=1234, ageMinutes=5
```
→ Hay otro proceso corriendo. Si no es el caso (proceso caído), borrar manualmente:
```sql
DELETE FROM locks WHERE name = 'publish_job';
```

### Score siempre bajo el umbral
→ Verificar que los `tags` en `news.json` coincidan con `HIGH_VALUE_TAGS` en `scorer.ts`. Los tags se normalizan a lowercase — `"IA"` y `"ia"` se tratan igual.

### Copy rechazado por overlap
→ Los posts recientes tienen frases similares. Ajustar `COPY_PHRASE_OVERLAP_THRESHOLD` o esperar hasta que roten los posts de referencia.

---

## 14. Estructura del proyecto

```
linkedin-news-automation/
├── src/
│   ├── auth/tokenManager.ts        # OAuth 2.0
│   ├── linkedin/client.ts          # HTTP client + errores tipados
│   ├── ingest/newsReader.ts        # Ingest + normalización + dedup
│   ├── scoring/scorer.ts           # Score con pesos configurables
│   ├── copy/generator.ts           # Copy con validación de calidad
│   ├── db/index.ts                 # SQLite + migraciones + lock
│   ├── jobs/
│   │   ├── publish.ts              # Pipeline con lock + rate limiting
│   │   ├── dryRun.ts               # Simulación solo-lectura
│   │   └── scheduler.ts            # Cron job
│   └── config/
│       ├── index.ts                # Variables de entorno validadas
│       └── logger.ts               # Winston
├── inputs/news.json
├── scripts/getToken.ts             # OAuth interactivo
├── tests/
│   ├── scoring.test.ts
│   ├── ingest.test.ts
│   ├── copy.test.ts
│   ├── db.test.ts                  # Dedup + lock + migraciones
│   ├── linkedin.test.ts            # Errores tipados + refresh único
│   └── pipeline.test.ts            # E2E dry-run
├── data/                           # Generado: linkedin_automation.db
├── logs/                           # Generado: combined.log, error.log
├── .env.example
├── package.json
└── README.md
```
