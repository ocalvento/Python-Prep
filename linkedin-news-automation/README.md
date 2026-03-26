# LinkedIn News Automation — BOIA Integration

Sistema de publicación automatizada en LinkedIn para contenido regulatorio argentino. Consume candidatos del sistema **BOIA** (Base de Observación de Impacto Administrativo), los evalúa con un scoring editorial específico para LinkedIn, genera posts en español orientados a impacto práctico, y los publica vía la API oficial de LinkedIn.

BOIA es la fuente de verdad regulatoria. Este sistema actúa como segunda capa editorial.

---

## Arquitectura

```
BOIA (fuente)
  │  Opción A: boia_candidates.json (default)
  │  Opción B: API REST interna de BOIA
  │  Opción C: SQLite de BOIA (mismo servidor)
  ▼
┌──────────────────────────────────────────────────────────────┐
│  ingest — Lee, valida (Zod), normaliza                        │
│  · BoiaCandidate: id, title, summary, organism, category      │
│  · Campos: boiaRelevanceScore, whyItMatters, affectedAudience │
│  · Normaliza URLs (strip utm_*, fbclid, gclid, etc.)          │
│  · Calcula contentHash = SHA-256("boia::" + id + "::" + url)  │
│  · Rechaza fechas futuras, deduplica por id dentro del batch  │
└──────────────────────────────────────────────────────────────┘
                              │ Filtro 1: boiaRelevanceScore < BOIA_MIN_RELEVANCE → SKIP
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  scoring/editorialScorer — LinkedIn Publish Score (0-100)     │
│  · organismRelevance  (0-25): BCRA/CNV/UIF/SEC/FED = 25 pts   │
│  · audienceImpact     (0-25): overlap con audiencia fintech   │
│  · messageClarity     (0-15): calidad del whyItMatters        │
│  · recency            (0-15): decaimiento exponencial 52h     │
│  · conversationPotential(0-10): tags de alto engagement       │
│  · dataBonus          (0-10): %, fechas, linkedinAngle        │
│  · technicalityPenalty(0-15): muy técnico = penaliza          │
└──────────────────────────────────────────────────────────────┘
                              │ Filtro 2: linkedinPublishScore < LINKEDIN_MIN_SCORE → SKIP
                              │ Filtro 3: contentHash ya en DB → SKIP (deduplicación)
                              │ Filtro 4: mismo organismo en esta corrida → SKIP
                              │   (excepto si linkedinPublishScore >= LINKEDIN_EXCEPTIONAL_SCORE)
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  copy/generator — Post regulatorio en español                 │
│  · Hook basado en tipo de acción (plazo/sanción/requisito)    │
│  · Cuerpo desde linkedinAngle (si existe) o whyItMatters      │
│  · Traduce lenguaje normativo a impacto de negocio            │
│  · No copia el summary verbatim. No inventa efectos legales   │
│  · Línea de audiencia: "Aplica especialmente a: fintechs..."  │
│  · CTA rotativo que invita al debate                          │
│  · Hashtags limpios (sin acentos, sin espacios)               │
│  · Valida: largo mínimo, quality score ≥ 40, overlap Jaccard  │
└──────────────────────────────────────────────────────────────┘
                              │ copy débil → SKIP
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  linkedin/client — POST /rest/posts                           │
│  · Errores tipados: auth / scope / rate_limit / validation    │
│  · Refresh token automático si 401 (una sola vez)             │
│  · No reintenta 400/403/422. Sí reintenta 429/5xx            │
│  · Token maskeado en logs                                     │
└──────────────────────────────────────────────────────────────┘
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  db — SQLite (better-sqlite3, WAL mode)                       │
│  · Guarda resultado de cada candidato procesado               │
│  · Schema versionado por PRAGMA user_version                  │
│  · Columns: boia_candidate_id, organism, category, breakdown  │
│  · Lock de concurrencia (tabla locks, PID + timestamp)        │
└──────────────────────────────────────────────────────────────┘
```

---

## Estructura del proyecto

```
linkedin-news-automation/
├── src/
│   ├── config/
│   │   ├── index.ts          # Config Zod-validada desde .env
│   │   └── logger.ts         # Winston logger (console + file)
│   ├── ingest/
│   │   ├── types.ts          # BoiaCandidate + BoidaCandidateSchema
│   │   ├── normalizeUrl.ts   # Strip tracking params
│   │   ├── boiaJsonAdapter.ts # Fuente: archivo JSON
│   │   ├── boiaApiAdapter.ts  # Fuente: API REST de BOIA
│   │   ├── boiaDbAdapter.ts   # Fuente: SQLite de BOIA (readonly)
│   │   └── index.ts          # Factory: fetchBoidaCandidates()
│   ├── scoring/
│   │   └── editorialScorer.ts # LinkedIn Publish Score para candidatos BOIA
│   ├── copy/
│   │   └── generator.ts      # Generador de posts regulatorios
│   ├── linkedin/
│   │   └── client.ts         # API client + LinkedInApiError
│   ├── db/
│   │   └── index.ts          # SQLite + migraciones + lock
│   ├── auth/
│   │   └── tokenManager.ts   # OAuth 2.0 + refresh tokens
│   └── jobs/
│       ├── publish.ts        # Job principal de publicación
│       ├── dryRun.ts         # Simulación read-only
│       └── scheduler.ts      # node-cron scheduler
├── tests/
│   ├── editorialScorer.test.ts  # Scoring editorial para BOIA
│   ├── boiaAdapters.test.ts     # JSON / API / DB adapters
│   ├── copy.test.ts             # Generador de copy
│   ├── pipeline.test.ts         # E2E dry-run con fixture BOIA
│   ├── db.test.ts               # SQLite, dedup, lock
│   ├── linkedin.test.ts         # Client, errores tipados
│   ├── ingest.test.ts           # newsReader (legacy)
│   └── scoring.test.ts          # scorer (legacy)
├── inputs/
│   └── boia_candidates.json     # Ejemplo de payload BOIA
├── scripts/
│   └── getToken.ts              # OAuth flow helper
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Requisitos

- Node.js 18+
- npm 9+
- SQLite (incluido vía `better-sqlite3`)

---

## Instalación

```bash
cd linkedin-news-automation
npm install
cp .env.example .env
# Editar .env con tus credenciales y configuración
```

---

## Configuración

### Variables obligatorias

```bash
# LinkedIn OAuth
LINKEDIN_CLIENT_ID=your_client_id
LINKEDIN_CLIENT_SECRET=your_client_secret
LINKEDIN_REDIRECT_URI=http://localhost:3000/callback
LINKEDIN_ACCESS_TOKEN=   # completar después de npm run get-token
```

### Variables de BOIA

```bash
# Tipo de fuente: json | api | db
BOIA_SOURCE=json

# Opción A — archivo JSON (default, MVP)
BOIA_JSON_PATH=./inputs/boia_candidates.json

# Opción B — API REST interna de BOIA
# BOIA_API_URL=http://localhost:4000
# BOIA_API_KEY=your_boia_api_key

# Opción C — SQLite de BOIA (mismo servidor)
# BOIA_DB_PATH=../boia/data/boia.db
# BOIA_DB_TABLE=candidates
```

### Filtros de publicación (doble capa)

```bash
# Filtro 1: Score mínimo de BOIA (fuente de verdad regulatoria)
BOIA_MIN_RELEVANCE=70

# Filtro 2: Score editorial mínimo para LinkedIn
LINKEDIN_MIN_SCORE=60

# Throttle por organismo (1 post por organismo por corrida)
LINKEDIN_SAME_ORGANISM_MAX=1
# Excepción: si el score es excepcional, permite un segundo post del mismo organismo
LINKEDIN_EXCEPTIONAL_SCORE=90

# Scoring
SCORE_PENALTY_MAX_POINTS=15
```

### Control operativo

```bash
DRY_RUN=false          # true: simula sin publicar
APPROVAL_REQUIRED=false # true: guarda como pending_approval para revisión manual
MAX_POSTS_PER_RUN=3    # rate limiting defensivo
MAX_NEWS_AGE_DAYS=30
```

---

## Payload de BOIA

Formato esperado del JSON (o devuelto por el API):

```json
[
  {
    "id": "boia-2026-03-001",
    "title": "BCRA establece nuevos requisitos de liquidez para PSP",
    "summary": "El Banco Central publicó la Comunicación A 8123 ...",
    "source_url": "https://www.bcra.gob.ar/comytexord/A8123.pdf",
    "published_at": "2026-03-24T10:00:00Z",
    "organism": "BCRA",
    "category": "regulacion_financiera",
    "tags": ["psp", "liquidez", "encajes", "regulacion", "fintech"],
    "boia_relevance_score": 92,
    "why_it_matters": "Los 180+ PSP habilitados deberán revisar su estructura...",
    "affected_audience": ["fintechs", "psp", "compliance", "bancos"],
    "linkedin_angle": "Las reglas de liquidez para PSP se endurecen: el BCRA exige..."
  }
]
```

**Campos obligatorios:** `id`, `title` (≥10 chars), `summary` (≥50 chars), `source_url` (URL válida), `published_at` (ISO 8601, no futura), `organism`, `category`, `boia_relevance_score` (0-100), `why_it_matters` (≥20 chars).

**Campos opcionales:** `tags`, `affected_audience`, `linkedin_angle` (si BOIA provee un ángulo editorial, se usa como base del cuerpo del post).

---

## Comandos

```bash
# Obtener tokens OAuth (flujo interactivo, hacer una sola vez)
npm run get-token

# Ver qué se publicaría sin tocar LinkedIn ni DB (100% read-only)
npm run dry-run

# Publicar (producción)
npm run publish-now

# Activar scheduler diario (9:00 AM por defecto)
npm run schedule

# Tests con coverage
npm test

# Build TypeScript
npm run build
```

### Dry-run en detalle

El dry-run (`DRY_RUN=true`) o `npm run dry-run` imprime un reporte completo:

```
════════════════════════════════════════════════════════════════════════
  DRY RUN — CANDIDATOS BOIA → LINKEDIN
════════════════════════════════════════════════════════════════════════
  Candidatos BOIA recibidos     : 6
  Se publicarían                : 3
  Saltados (boia score bajo)    : 1
  Saltados (linkedin score bajo): 1
  Saltados (duplicado)          : 0
  Saltados (copy débil)         : 0
  Saltados (throttle organismo) : 1
════════════════════════════════════════════════════════════════════════

  ── POST 1/3 [───────────────────────────────────────────────────]
  ID            : boia-2026-03-001
  Título        : BCRA establece nuevos requisitos de liquidez para PSP
  Organismo     : BCRA
  BOIA score    : 92/100
  LinkedIn score: 88/100
  Breakdown     : organism=25 audience=22 clarity=12 recency=14 conversation=9 bonus=10 penalty=-4
  Audiencia     : fintechs, psp, compliance, bancos
  Chars/Quality : 512 chars | quality=85/100
  Hashtags      : #bcra #regulacionfinanciera #psp #fintech

  TEXTO DEL POST:
  ...
```

### Modo aprobación manual

Con `APPROVAL_REQUIRED=true`, los posts se guardan como `pending_approval` en la DB en lugar de publicarse. Para publicarlos después:

```bash
npm run publish-approved
```

---

## Scoring editorial

El **LinkedIn Publish Score** (0-100) evalúa si un candidato de BOIA merece publicación en LinkedIn:

| Señal | Pts | Criterio |
|-------|-----|---------|
| `organismRelevance` | 0–25 | BCRA/CNV/UIF/SEC/FED = 25; organismos LATAM = 15; desconocido = 5 |
| `audienceImpact` | 0–25 | Overlap entre `affectedAudience` y audiencia target fintech/compliance |
| `messageClarity` | 0–15 | Longitud y frases de impacto en `whyItMatters` |
| `recency` | 0–15 | Decaimiento exponencial, half-life 52h |
| `conversationPotential` | 0–10 | Tags de alta resonancia (cripto, IA, pagos, compliance) |
| `dataBonus` | 0–10 | Datos numéricos (%), fechas, `linkedinAngle` provisto |
| `technicalityPenalty` | 0–15 | Penaliza: refs legales densas, siglas sin contexto, `whyItMatters` corto |

**Doble filtro:**
1. `boiaRelevanceScore < BOIA_MIN_RELEVANCE` → rechazado (BOIA dijo que no es suficientemente relevante)
2. `linkedinPublishScore < LINKEDIN_MIN_SCORE` → rechazado (no es adecuado para LinkedIn)

---

## Principios del copy regulatorio

El generador de posts aplica estas reglas editoriales:

- **Traduce, no transcribe**: usa `whyItMatters` o `linkedinAngle` como base, nunca copia el `summary`
- **Empieza por el impacto**: hook basado en el tipo de acción (plazo, sanción, nuevo requisito)
- **Organismo mencionado una sola vez**, brevemente, de forma natural
- **No inventa efectos jurídicos** que BOIA no haya explicitado
- **Tono**: profesional, concreto, orientado a regulación + negocio (no académico, no alarmista)
- **CTA**: invita al debate ("¿Cómo lo están procesando en sus organizaciones?"), no a clickear

---

## Garantías de seguridad

- **Deduplicación**: SHA-256 de `"boia::" + id + "::" + normalizedUrl` → ningún post se repite
- **Concurrency lock**: tabla `locks` en SQLite con PID y timestamp. Stale locks se limpian automáticamente
- **No retry en errores client-side**: 400/403/422 abortan sin reintentar
- **Abort en auth error**: si LinkedIn devuelve un error de autenticación, el job se detiene
- **Token maskeado**: los tokens nunca aparecen en logs
- **Rate limiting defensivo**: `MAX_POSTS_PER_RUN` limita posts por corrida
- **Throttle por organismo**: máximo 1 post por organismo por corrida (configurable)

---

## Migraciones de DB

La base de datos usa `PRAGMA user_version` para versionar el schema. Las migraciones son idempotentes. Schema actual (v3):

```sql
CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash TEXT UNIQUE NOT NULL,
  title TEXT,
  source_url TEXT,
  score INTEGER,
  status TEXT CHECK(status IN ('published','skipped','failed','pending_approval','dry_run')),
  created_at TEXT DEFAULT (datetime('now')),
  published_at_real TEXT,
  linkedin_urn TEXT,
  linkedin_post_id TEXT,
  copy_text TEXT,
  post_text TEXT,
  copy_quality_score INTEGER,
  error_message TEXT,
  failure_reason TEXT,
  score_breakdown TEXT,
  -- v3: campos BOIA
  boia_candidate_id TEXT,
  boia_relevance_score INTEGER,
  linkedin_publish_score INTEGER,
  organism TEXT,
  category TEXT
);
```

---

## Tests

```bash
npm test               # todos los tests con coverage
npm test -- --testPathPattern=editorialScorer  # solo editorial scorer
npm test -- --testPathPattern=boiaAdapters     # solo adapters BOIA
```

**Cobertura:**
- `editorialScorer.test.ts` — 22 tests: scoring por organismo, audiencia, claridad, recencia, penalidades, bonus, ordenamiento
- `boiaAdapters.test.ts` — 23 tests: JSON adapter (dedup, inválidos, tracking params), API adapter (array / { items }, errores HTTP), DB adapter (status filter, deserialización JSON, fila inválida)
- `copy.test.ts` — 14 tests: happy path, validación calidad, copy regulatorio, truncado
- `pipeline.test.ts` — 7 tests: E2E dry-run con fixture BOIA, filtros, read-only
- `db.test.ts` — tests de DB: dedup, status values, concurrency lock, migración
- `linkedin.test.ts` — tests del client: extractPostId, error kinds, retry semantics

---

## Flujo OAuth (primer uso)

```bash
# 1. Configurar en .env:
LINKEDIN_CLIENT_ID=...
LINKEDIN_CLIENT_SECRET=...
LINKEDIN_REDIRECT_URI=http://localhost:3000/callback

# 2. Obtener tokens:
npm run get-token
# Abre browser, autoriza, copia el token al .env

# 3. Verificar:
npm run dry-run
```

Los refresh tokens se gestionan automáticamente. Si el access token expira, se renueva antes de publicar (un solo intento).

---

## Variables de entorno completas

Ver `.env.example` para la lista completa con comentarios.
