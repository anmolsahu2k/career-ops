# Modo: scan — Portal Scanner (Descubrimiento + Evaluación in-line)

Escanea portales de empleo configurados, filtra por relevancia de título, y **evalúa cada oferta nueva inmediatamente** (no triage state).

> **HARD OVERRIDE for Anmol's workspace (CLAUDE.md Rule 7):** Scan and evaluation can run together OR separately. There is no `data/pipeline.md` triage inbox. After `scan.mjs` writes `data/scan-results-{YYYY-MM-DD}.tsv`, the skill workflow has two valid completion modes: **(default — inline)** immediately evaluate every row through auto-pipeline (parallel agents) and DELETE the TSV before returning; **(scan-only mode, when invoked as `/career-ops scan scan-only`)** stop after the title-level filter, report counts, and leave the TSV on disk for a later invocation to consume. In split mode, the next `/career-ops` invocation MUST detect any pre-existing `data/scan-results-*.tsv` files and run the inline-evaluation pass against them before doing anything else; that pass is what deletes the TSV. The scan workflow is not complete until every candidate has either an eval report or an explicit drop reason logged in `scan-history.tsv`. The Spanish "pipeline.md / Pendientes" steps below are SUPERSEDED — read them as historical/upstream context only.

> **Nota (v1.5+):** El escáner por defecto (`scan.mjs` / `npm run scan`) es **zero-token** y sólo consulta directamente las APIs públicas de Greenhouse, Ashby y Lever. Los niveles con Playwright/WebSearch descritos abajo son el flujo **agente** (ejecutado por Claude/Codex), no lo que hace `scan.mjs`. Si una empresa no tiene API Greenhouse/Ashby/Lever, `scan.mjs` la ignorará; para esos casos, el agente debe completar manualmente el Nivel 1 (Playwright) o Nivel 3 (WebSearch).

## Ejecución recomendada

Ejecutar como subagente para no consumir contexto del main:

```
Agent(
    subagent_type="general-purpose",
    prompt="[contenido de este archivo + datos específicos]",
    run_in_background=True
)
```

## Configuración

Leer `portals.yml` que contiene:
- `search_queries`: Lista de queries WebSearch con `site:` filters por portal (descubrimiento amplio)
- `tracked_companies`: Empresas específicas con `careers_url` para navegación directa
- `title_filter`: Keywords positive/negative/seniority_boost para filtrado de títulos

## Estrategia de descubrimiento (3 niveles)

### Nivel 1 — Playwright directo (PRINCIPAL)

**Para cada empresa en `tracked_companies`:** Navegar a su `careers_url` con Playwright (`browser_navigate` + `browser_snapshot`), leer TODOS los job listings visibles, y extraer título + URL de cada uno. Este es el método más fiable porque:
- Ve la página en tiempo real (no resultados cacheados de Google)
- Funciona con SPAs (Ashby, Lever, Workday)
- Detecta ofertas nuevas al instante
- No depende de la indexación de Google

**Cada empresa DEBE tener `careers_url` en portals.yml.** Si no la tiene, buscarla una vez, guardarla, y usar en futuros scans.

### Nivel 2 — ATS APIs / Feeds (COMPLEMENTARIO)

Para empresas con API pública o feed estructurado, usar la respuesta JSON/XML como complemento rápido de Nivel 1. Es más rápido que Playwright y reduce errores de scraping visual.

**Soporte actual (variables entre `{}`):**
- **Greenhouse**: `https://boards-api.greenhouse.io/v1/boards/{company}/jobs`
- **Ashby**: `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR**: lista `https://{company}.bamboohr.com/careers/list`; detalle de una oferta `https://{company}.bamboohr.com/careers/{id}/detail`
- **Lever**: `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor**: `https://{company}.teamtailor.com/jobs.rss`
- **Workday**: `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**Convención de parsing por provider:**
- `greenhouse`: `jobs[]` → `title`, `absolute_url`
- `ashby`: GraphQL `ApiJobBoardWithTeams` con `organizationHostedJobsPageName={company}` → `jobBoard.jobPostings[]` (`title`, `id`; construir URL pública si no viene en payload)
- `bamboohr`: lista `result[]` → `jobOpeningName`, `id`; construir URL de detalle `https://{company}.bamboohr.com/careers/{id}/detail`; para leer el JD completo, hacer GET del detalle y usar `result.jobOpening` (`jobOpeningName`, `description`, `datePosted`, `minimumExperience`, `compensation`, `jobOpeningShareUrl`)
- `lever`: array raíz `[]` → `text`, `hostedUrl` (fallback: `applyUrl`)
- `teamtailor`: RSS items → `title`, `link`
- `workday`: `jobPostings[]`/`jobPostings` (según tenant) → `title`, `externalPath` o URL construida desde el host

### Nivel 3 — WebSearch queries (DESCUBRIMIENTO AMPLIO)

Los `search_queries` con `site:` filters cubren portales de forma transversal (todos los Ashby, todos los Greenhouse, etc.). Útil para descubrir empresas NUEVAS que aún no están en `tracked_companies`, pero los resultados pueden estar desfasados.

**Prioridad de ejecución:**
1. Nivel 1: Playwright → todas las `tracked_companies` con `careers_url`
2. Nivel 2: API → todas las `tracked_companies` con `api:`
3. Nivel 3: WebSearch → todos los `search_queries` con `enabled: true`

Los niveles son aditivos — se ejecutan todos, los resultados se mezclan y deduplicar.

## Workflow

1. **Leer configuración**: `portals.yml`
2. **Leer historial**: `data/scan-history.tsv` → URLs ya vistas
3. **Leer dedup source**: `data/applications.md` (no pipeline.md — triage state eliminated per Anmol's no-triage-state rule)

4. **Nivel 1 — Playwright scan** (paralelo en batches de 3-5):
   Para cada empresa en `tracked_companies` con `enabled: true` y `careers_url` definida:
   a. `browser_navigate` a la `careers_url`
   b. `browser_snapshot` para leer todos los job listings
   c. Si la página tiene filtros/departamentos, navegar las secciones relevantes
   d. Para cada job listing extraer: `{title, url, company}`
   e. Si la página pagina resultados, navegar páginas adicionales
   f. Acumular en lista de candidatos
   g. Si `careers_url` falla (404, redirect), intentar `scan_query` como fallback y anotar para actualizar la URL

5. **Nivel 2 — ATS APIs / feeds** (paralelo):
   Para cada empresa en `tracked_companies` con `api:` definida y `enabled: true`:
   a. WebFetch de la URL de API/feed
   b. Si `api_provider` está definido, usar su parser; si no está definido, inferir por dominio (`boards-api.greenhouse.io`, `jobs.ashbyhq.com`, `api.lever.co`, `*.bamboohr.com`, `*.teamtailor.com`, `*.myworkdayjobs.com`)
   c. Para **Ashby**, enviar POST con:
      - `operationName: ApiJobBoardWithTeams`
      - `variables.organizationHostedJobsPageName: {company}`
      - query GraphQL de `jobBoardWithTeams` + `jobPostings { id title locationName employmentType compensationTierSummary }`
   d. Para **BambooHR**, la lista solo trae metadatos básicos. Para cada item relevante, leer `id`, hacer GET a `https://{company}.bamboohr.com/careers/{id}/detail`, y extraer el JD completo desde `result.jobOpening`. Usar `jobOpeningShareUrl` como URL pública si viene; si no, usar la URL de detalle.
   e. Para **Workday**, enviar POST JSON con al menos `{"appliedFacets":{},"limit":20,"offset":0,"searchText":""}` y paginar por `offset` hasta agotar resultados
   f. Para cada job extraer y normalizar: `{title, url, company}`
   g. Acumular en lista de candidatos (dedup con Nivel 1)

6. **Nivel 3 — WebSearch queries** (paralelo si posible):
   Para cada query en `search_queries` con `enabled: true`:
   a. Ejecutar WebSearch con el `query` definido
   b. De cada resultado extraer: `{title, url, company}`
      - **title**: del título del resultado (antes del " @ " o " | ")
      - **url**: URL del resultado
      - **company**: después del " @ " en el título, o extraer del dominio/path
   c. Acumular en lista de candidatos (dedup con Nivel 1+2)

6. **Filtrar por título** usando `title_filter` de `portals.yml`:
   - Al menos 1 keyword de `positive` debe aparecer en el título (case-insensitive)
   - 0 keywords de `negative` deben aparecer
   - `seniority_boost` keywords dan prioridad pero no son obligatorios

7. **Deduplicar** contra 2 fuentes:
   - `scan-history.tsv` → URL exacta ya vista
   - `applications.md` → empresa + rol normalizado ya evaluado

7.5. **Verificar liveness de resultados de WebSearch (Nivel 3)** — ANTES de añadir a pipeline:

   Los resultados de WebSearch pueden estar desactualizados (Google cachea resultados durante semanas o meses). Para evitar evaluar ofertas expiradas, verificar con Playwright cada URL nueva que provenga del Nivel 3. Los Niveles 1 y 2 son inherentemente en tiempo real y no requieren esta verificación.

   Para cada URL nueva de Nivel 3 (parallel OK — see [_shared.md](_shared.md) Playwright entry; preferred pattern is one shared Chromium with N concurrent pages, e.g. [liveness-parallel.mjs](../liveness-parallel.mjs) at CONCURRENCY=20):
   a. `browser_navigate` a la URL
   b. `browser_snapshot` para leer el contenido
   c. Clasificar:
      - **Activa**: título del puesto visible + descripción del rol + control visible de Apply/Submit/Solicitar dentro del contenido principal. No contar texto genérico de header/navbar/footer.
      - **Expirada** (cualquiera de estas señales):
        - URL final contiene `?error=true` (Greenhouse redirige así cuando la oferta está cerrada)
        - Página contiene: "job no longer available" / "no longer open" / "position has been filled" / "this job has expired" / "page not found"
        - Solo navbar y footer visibles, sin contenido JD (contenido < ~300 chars)
   d. Si expirada: registrar en `scan-history.tsv` con status `skipped_expired` y descartar
   e. Si activa: continuar al paso 8

   **No interrumpir el scan entero si una URL falla.** Si `browser_navigate` da error (timeout, 403, etc.), marcar como `skipped_expired` y continuar con la siguiente.

8. **Para cada oferta nueva verificada que pase filtros (Anmol's workspace — no-triage rule):**
   a. Registrar en `scan-history.tsv`: `{url}\t{date}\t{query_name}\t{title}\t{company}\tadded`
   b. Acumular en `data/scan-results-{date}.tsv` (transient; consumed in step 12)
   c. **DO NOT write to `data/pipeline.md`** — it does not exist as a triage queue.

12. **Evaluation pass — REQUIRED in default mode, SKIPPED in `scan-only` mode:**
    > **Mode check.** If invoked as `/career-ops scan scan-only` (or any equivalent split-mode flag the user passed), STOP here: report `{date}.tsv` row count + which company/role buckets, surface the TSV path, and exit. Do NOT dispatch eval agents and do NOT delete the TSV. Otherwise continue with steps a-h below to complete inline evaluation.
    a. Read `data/scan-results-{date}.tsv` — list of N new candidates with title-level filter applied. (In split-mode resume, also pick up any older `data/scan-results-*.tsv` files left from prior scan-only invocations and process them in the same pass.)
    b. Apply a second title-level filter to drop obvious non-targets (sales/GTM/marketing/HR/legal/finance/senior/staff/principal/non-target geo) without writing per-URL eval reports. Log dropped rows in `scan-history.tsv` with status `skipped_filter` and a one-line reason.
    c. **Liveness gate (REQUIRED before agent dispatch).** Run `npm run liveness:bulk -- /tmp/scan-urls.txt /tmp/scan-liveness.tsv` over the surviving URLs (zero Claude tokens, ~2-5 min for hundreds of URLs at CONCURRENCY=20). For results classified `expired` (HTTP 404/410, "no longer available", nav-error, JS-only empty page): drop the URL with `scan-history.tsv` status `skipped_expired` and **do NOT dispatch an eval agent**. For results `uncertain` (typically iCIMS/Workday SPAs whose apply iframe didn't render): keep the URL but flag the resulting tracker row with `LIVENESS-UNCERTAIN {date}.` prefix in the Notes column. This typically saves 25-35% of agent compute by short-circuiting dead URLs before WebFetch retries blow time on them. Empirical baseline (2026-05-04): 742 URLs → 530 active, 157 expired, 55 uncertain in 212s wall time.
    d. For surviving candidates, dispatch parallel evaluation agents (one batch per ~5 URLs). Each agent runs the full auto-pipeline per URL: WebFetch JD → A-F scoring → write report to `reports/{company-slug}/{NN}-{role-slug}-{date}.md` with `**URL:**` header → write a 9-column tracker line to `batch/tracker-additions/{NN}.tsv`.

       **JD-snippet shortcut (Adzuna and other API-aggregator sources).** If the candidate row's Notes column carries a `jd_snippet:` field (the source API's ~500-char description, written at ingest time by `scripts/adzuna-ingest.py` and other adapters), use the snippet as the primary JD source for scoring. Adzuna in particular rate-limits the detail-page URL (`adzuna.com/details/{id}`) when N parallel eval agents WebFetch it simultaneously → HTTP 429 → eval falls back to title-only and flags `JD-FETCH-UNCERTAIN`. The snippet is sufficient for A-F scoring; WebFetch only if the snippet is empty or the role looks borderline and you want fuller context. Never fail the eval on 429: the snippet is the authoritative summary.
    e. Pre-allocate sequential `NN` numbers from `max(applications.md ID, reports/ NN prefix) + 1`.
    f. After all agents complete, merge `batch/tracker-additions/*.tsv` into `data/applications.md` and run `node verify-pipeline.mjs` for schema integrity.
    g. Delete `data/scan-results-{date}.tsv` (transient — consumed).
    h. The scan is complete only when every row in the original TSV has either an eval report (Evaluated/SKIP), a `skipped_filter` log line, or a `skipped_expired` log line.

### Liveness gate cheat sheet (post-aggregator and post-merge)

```bash
# After aggregator-intake.py writes placeholder TSVs, before dispatching evals:
npm run liveness:batch /tmp/liveness-results.tsv
python3 scripts/prune-by-liveness.py

# Periodically (recommended weekly) to keep applications.md clean:
npm run liveness:batch /tmp/liveness-results.tsv
python3 scripts/prune-by-liveness.py    # marks dead evaluated rows as Discarded
```

9. **Ofertas filtradas por título**: registrar en `scan-history.tsv` con status `skipped_title`
10. **Ofertas duplicadas**: registrar con status `skipped_dup`
11. **Ofertas expiradas (Nivel 3)**: registrar con status `skipped_expired`

## Extracción de título y empresa de WebSearch results

Los resultados de WebSearch vienen en formato: `"Job Title @ Company"` o `"Job Title | Company"` o `"Job Title — Company"`.

Patrones de extracción por portal:
- **Ashby**: `"Senior AI PM (Remote) @ EverAI"` → title: `Senior AI PM`, company: `EverAI`
- **Greenhouse**: `"AI Engineer at Anthropic"` → title: `AI Engineer`, company: `Anthropic`
- **Lever**: `"Product Manager - AI @ Temporal"` → title: `Product Manager - AI`, company: `Temporal`

Regex genérico: `(.+?)(?:\s*[@|—–-]\s*|\s+at\s+)(.+?)$`

## URLs privadas

Si se encuentra una URL no accesible públicamente:
1. Guardar el JD en `jds/{company}-{role-slug}.md`
2. Anmol's workspace: añadir como fila en `data/scan-results-{date}.tsv` con `url=local:jds/{company}-{role-slug}.md` para que la evaluación inline lo lea desde disco. NO escribir a `pipeline.md` (no existe).

## Scan History

`data/scan-history.tsv` trackea TODAS las URLs vistas:

```
url	first_seen	portal	title	company	status
https://...	2026-02-10	Ashby — AI PM	PM AI	Acme	added
https://...	2026-02-10	Greenhouse — SA	Junior Dev	BigCo	skipped_title
https://...	2026-02-10	Ashby — AI PM	SA AI	OldCo	skipped_dup
https://...	2026-02-10	WebSearch — AI PM	PM AI	ClosedCo	skipped_expired
```

## Resumen de salida

```
Portal Scan — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━
Queries ejecutados: N
Ofertas encontradas: N total
Filtradas por título: N relevantes
Duplicadas: N (ya evaluadas o en pipeline)
Expiradas descartadas: N (links muertos, Nivel 3)
Nuevos candidatos: N escritos a data/scan-results-{date}.tsv

  + {company} | {title} | {query_name}
  ...

→ Anmol's workspace: in default mode, continue to step 12 (evaluation pass) — every row in scan-results-{date}.tsv must be evaluated and the TSV deleted before the scan is complete. In `scan-only` mode, stop here and leave the TSV on disk for a follow-up `/career-ops` invocation to consume.
```

## Gestión de careers_url

Cada empresa en `tracked_companies` debe tener `careers_url` — la URL directa a su página de ofertas. Esto evita buscarlo cada vez.

**REGLA: Usa siempre la URL corporativa de la empresa; recurre al endpoint ATS solo si no existe página corporativa propia.**

El `careers_url` debe apuntar a la página de empleo propia de la empresa siempre que esté disponible. Muchas empresas usan Workday, Greenhouse o Lever por debajo, pero exponen los IDs de las vacantes solo a través de su dominio corporativo. Usar la URL ATS directa cuando existe una página corporativa puede causar falsos errores 410 porque los IDs de los puestos no coinciden.

| ✅ Correcto (corporativa) | ❌ Incorrecto como primera opción (ATS directo) |
|---|---|
| `https://careers.mastercard.com` | `https://mastercard.wd1.myworkdayjobs.com` |
| `https://openai.com/careers` | `https://job-boards.greenhouse.io/openai` |
| `https://stripe.com/jobs` | `https://jobs.lever.co/stripe` |

Fallback: si solo tienes la URL ATS directa, navega primero al sitio web de la empresa y localiza su página corporativa de empleo. Usa la URL ATS directa únicamente si la empresa no tiene página corporativa propia.

**Patrones conocidos por plataforma:**
- **Ashby:** `https://jobs.ashbyhq.com/{slug}`
- **Greenhouse:** `https://job-boards.greenhouse.io/{slug}` o `https://job-boards.eu.greenhouse.io/{slug}`
- **Lever:** `https://jobs.lever.co/{slug}`
- **BambooHR:** lista `https://{company}.bamboohr.com/careers/list`; detalle `https://{company}.bamboohr.com/careers/{id}/detail`
- **Teamtailor:** `https://{company}.teamtailor.com/jobs`
- **Workday:** `https://{company}.{shard}.myworkdayjobs.com/{site}`
- **Custom:** La URL propia de la empresa (ej: `https://openai.com/careers`)

**Patrones de API/feed por plataforma:**
- **Ashby API:** `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR API:** lista `https://{company}.bamboohr.com/careers/list`; detalle `https://{company}.bamboohr.com/careers/{id}/detail` (`result.jobOpening`)
- **Lever API:** `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor RSS:** `https://{company}.teamtailor.com/jobs.rss`
- **Workday API:** `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**Si `careers_url` no existe** para una empresa:
1. Intentar el patrón de su plataforma conocida
2. Si falla, hacer un WebSearch rápido: `"{company}" careers jobs`
3. Navegar con Playwright para confirmar que funciona
4. **Guardar la URL encontrada en portals.yml** para futuros scans

**Si `careers_url` devuelve 404 o redirect:**
1. Anotar en el resumen de salida
2. Intentar scan_query como fallback
3. Marcar para actualización manual

## Mantenimiento del portals.yml

- **SIEMPRE guardar `careers_url`** cuando se añade una empresa nueva
- Añadir nuevos queries según se descubran portales o roles interesantes
- Desactivar queries con `enabled: false` si generan demasiado ruido
- Ajustar keywords de filtrado según evolucionen los roles target
- Añadir empresas a `tracked_companies` cuando interese seguirlas de cerca
- Verificar `careers_url` periódicamente — las empresas cambian de plataforma ATS
