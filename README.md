# MCP PostgreSQL

Servidor [Model Context Protocol](https://modelcontextprotocol.io) que expone introspección y consulta **read-only** sobre PostgreSQL. Diseñado para alimentar de contexto a Claude (Claude Code, Claude Desktop) sin riesgo de escritura.

- **13 tools** de introspección, consulta, EXPLAIN y estadísticas de almacenamiento
- **2 resources** navegables (`postgres://schema/{schema}`, `postgres://table/{schema}/{table}`)
- **4 prompts** listos para usar (`audit-table`, `find-tables`, `explain-foreign-keys`, `profile-slow-query`)
- **Read-only reforzado**: `SET TRANSACTION READ ONLY`, statement timeout, cap de filas, single-statement, validación de keywords
- **Schema allow-list** vía `DB_SCHEMAS`
- Empaquetable como **MCPB** para Claude Desktop (`pnpm run mcpb:pack`)

---

## Tabla de contenidos

- [Quickstart](#quickstart)
- [Configuración](#configuración)
- [Integración con Claude Code](#integración-con-claude-code)
- [Integración con Claude Desktop (MCPB)](#integración-con-claude-desktop-mcpb)
- [Tools](#tools)
- [Resources](#resources)
- [Prompts](#prompts)
- [Seguridad](#seguridad)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Desarrollo](#desarrollo)
- [Troubleshooting](#troubleshooting)

---

## Quickstart

Requisitos: Node ≥ 18 y `pnpm`.

```bash
pnpm install
pnpm run build
cp .env.example .env       # edita tus credenciales
npx tsx test-connection.ts # verifica conectividad
```

Luego registra el servidor en Claude Code:

```bash
claude mcp add --transport stdio postgres \
  -- node /ruta/absoluta/al/proyecto/dist/index.js
```

## Configuración

Copia `.env.example` a `.env` y edita los valores:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=nombre_base_datos
DB_USER=usuario
DB_PASSWORD=contraseña
DB_SSL=false                       # true para AWS RDS / Supabase / Neon
DB_SSL_REJECT_UNAUTHORIZED=true    # mantener true en producción
DB_SCHEMAS=public                  # esquemas permitidos, separados por coma. Vacío = todos los no-sistema
DEFAULT_LIMIT=5                    # LIMIT por defecto en queries (máx 100)
```

### Entornos preconfigurados

Hay varios archivos `.env.<entorno>` para alternar entre bases de datos sin reescribir credenciales:

```bash
cp .env.ecosistema-prd .env       # producción
cp .env.ecosistema-tst .env       # testing
cp .env.db-admision-tst .env      # admisión testing
# ...etc.
```

> **Recomendación**: usa un **rol de PostgreSQL de solo lectura** (`CREATE ROLE ... LOGIN; GRANT USAGE ON SCHEMA ... TO ...; GRANT SELECT ON ALL TABLES IN SCHEMA ... TO ...;`). El servidor refuerza READ ONLY, pero la defensa en profundidad importa.

## Integración con Claude Code

### Opción A — `claude mcp add` (recomendado)

Pasando credenciales como variables de entorno:

```bash
claude mcp add \
  --transport stdio \
  --env DB_HOST=localhost \
  --env DB_PORT=5432 \
  --env DB_NAME=mi_base \
  --env DB_USER=mi_user \
  --env DB_PASSWORD=mi_password \
  --env DB_SCHEMAS=public \
  postgres \
  -- node /ruta/absoluta/al/proyecto/dist/index.js
```

Tomando el `.env` del propio repo (omite los `--env`):

```bash
claude mcp add --transport stdio postgres \
  -- node /ruta/absoluta/al/proyecto/dist/index.js
```

Scope global (disponible en todos los proyectos):

```bash
claude mcp add --scope user --transport stdio postgres \
  -- node /ruta/absoluta/al/proyecto/dist/index.js
```

### Opción B — JSON manual

```json
{
  "mcpServers": {
    "postgres": {
      "command": "node",
      "args": ["/ruta/absoluta/al/proyecto/dist/index.js"],
      "env": {
        "DB_HOST": "...",
        "DB_NAME": "...",
        "DB_USER": "...",
        "DB_PASSWORD": "...",
        "DB_SCHEMAS": "public"
      }
    }
  }
}
```

## Integración con Claude Desktop (MCPB)

El proyecto incluye un `manifest.json` listo para empaquetar como [MCPB](https://modelcontextprotocol.io) (Claude Desktop Bundle).

```bash
pnpm run build
pnpm run mcpb:pack    # genera mcp_postgres.mcpb en la raíz del repo
```

El `.mcpb` es un **artefacto de build** (está en `.gitignore`) — se regenera cuando lo necesites. No lo subas al repo.

### Qué hacer con `mcp_postgres.mcpb`

**Uso personal (instalarlo en tu Claude Desktop):**

1. Abre Claude Desktop → **Settings** → **Extensions**
2. Arrastra `mcp_postgres.mcpb` a la ventana (o usa "Install extension")
3. Claude Desktop te pedirá los datos de conexión (host, user, password, etc.) mediante el formulario definido en `user_config` del `manifest.json` — el campo `db_password` está marcado como `sensitive`
4. Una vez instalado, puedes borrar el archivo `.mcpb` local

**Distribución privada (compartir con tu equipo):**

- Súbelo como release asset en GitHub: `gh release create v1.1.0 mcp_postgres.mcpb`
- O distribúyelo por un storage interno (S3, Drive, etc.) y comparte el link
- Tus compañeros descargan el `.mcpb` y lo arrastran a Claude Desktop

**Distribución pública:** publícalo en el MCP Bundle Directory cuando esté disponible. Mientras tanto, GitHub Releases es el canal estándar.

**Si no lo vas a instalar ahora:** simplemente bórralo (`rm mcp_postgres.mcpb`) y regenéralo con `pnpm run mcpb:pack` cuando lo necesites.

## Tools

Todas las tools llevan `readOnlyHint: true`, `destructiveHint: false` y `outputSchema` Zod para `structuredContent`. Los errores recuperables se devuelven como `{ isError: true, content }`, no como excepciones de protocolo.

### Introspección

| Tool | Descripción |
|------|-------------|
| `postgres_list_schemas` | Lista esquemas accesibles. |
| `postgres_list_tables` | Tablas de un esquema con conteo de columnas (paginado). |
| `postgres_describe_table` | Columnas, constraints (PK/FK/UNIQUE) e índices. |
| `postgres_list_functions` | Funciones/procedimientos con firma, retorno y lenguaje (paginado). |
| `postgres_list_triggers` | Triggers con tabla, evento y timing (paginado). |
| `postgres_get_function_definition` | Código fuente de una función (con soporte de sobrecarga). |
| `postgres_get_trigger_definition` | Definición completa de un trigger. |
| `postgres_list_views` | Vistas regulares y materializadas (paginado). |
| `postgres_search_columns` | Busca columnas por nombre/patrón en todos los esquemas permitidos. |

### Consulta y análisis

| Tool | Descripción |
|------|-------------|
| `postgres_query_table` | SELECT seguro sobre una sola tabla con filtros estructurados. |
| `postgres_execute_query` | SELECT/WITH avanzado (JOINs, CTEs, agregaciones). Single-statement, READ ONLY. |
| `postgres_explain_query` | EXPLAIN / EXPLAIN ANALYZE de un SELECT — perfila planes antes de ejecutar. |
| `postgres_get_table_stats` | Tamaño total/tabla/índices/toast, vacuum/analyze, índices con `idx_scan = 0`. |

Las tools paginadas (`postgres_list_*`) aceptan `limit`/`offset` y devuelven `has_more`/`next_offset` para iterar.

## Resources

URIs navegables que el host puede consumir como contexto:

| URI template | Contenido |
|--------------|-----------|
| `postgres://schema/{schema}` | Resumen del esquema: tablas, vistas, funciones, triggers, conteos. |
| `postgres://table/{schema}/{table}` | Estructura completa de una tabla (columnas + constraints + índices). |

## Prompts

Slash commands disponibles en Claude Code (`/mcp__postgres__<prompt>`):

| Prompt | Argumentos | Propósito |
|--------|------------|-----------|
| `audit-table` | `schema`, `table` | Auditoría estructurada: schema, storage, sample, triggers, riesgos. |
| `find-tables` | `pattern` | Encuentra columnas/tablas por patrón fuzzy en todos los esquemas. |
| `explain-foreign-keys` | `schema` | Mapa textual del grafo de FKs (hubs, huérfanos). |
| `profile-slow-query` | `sql` | EXPLAIN ANALYZE + recomendaciones priorizadas (índices faltantes, scans, sorts caros). |

Ejemplo (en Claude Code):

```
/mcp__postgres__audit-table schema=public table=users
/mcp__postgres__profile-slow-query sql="SELECT * FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE country='PE')"
```

## Seguridad

- **Filtrado de esquemas**: `DB_SCHEMAS` restringe acceso a nivel de aplicación; además `postgres_execute_query` ajusta `search_path` local por consulta.
- **Query table seguro**: `postgres_query_table` usa columnas/filtros estructurados con parámetros SQL — nunca concatena strings.
- **Read-only reforzado**: `postgres_execute_query` y `postgres_explain_query` corren bajo `SET TRANSACTION READ ONLY` con `statement_timeout = 30s`.
- **Single-statement**: rechaza queries con `;` interno y palabras clave de escritura (INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE/GRANT/REVOKE/EXECUTE/COPY) validadas por regex con `\b`.
- **Cap de filas**: máximo 100 filas por consulta; se inyecta o clampa el `LIMIT` automáticamente.
- **TLS seguro por defecto**: cuando `DB_SSL=true`, `DB_SSL_REJECT_UNAUTHORIZED=true` por defecto.
- **Timeouts**: 10 s para establecer conexión, 30 s para statement.
- **Defensa en profundidad**: aun así, **usa un rol de PostgreSQL de solo lectura** en el `DB_USER`.

## Estructura del proyecto

```
src/
├── index.ts              # Bootstrap — conecta transport y verifica DB
├── server.ts             # createServer() — instancia McpServer, registra tools/resources/prompts
├── db/
│   └── pool.ts           # Pool, allowedSchemas, defaultLimit, isSchemaAllowed
├── tools/
│   ├── introspection.ts  # list_schemas / list_tables / describe_table / list_views / search_columns
│   ├── objects.ts        # list_functions / list_triggers / get_*_definition
│   ├── query.ts          # query_table / execute_query
│   └── analysis.ts       # explain_query / get_table_stats
├── resources/
│   └── index.ts          # postgres://schema/* y postgres://table/*
├── prompts/
│   └── index.ts          # audit-table / find-tables / explain-foreign-keys / profile-slow-query
└── utils/
    └── response.ts       # formatResult(), assertSchemaAllowed(), CHARACTER_LIMIT
```

## Desarrollo

```bash
pnpm run build      # Compila TypeScript → dist/
pnpm run dev        # Watch mode
pnpm start          # Ejecuta el servidor compilado
pnpm run mcpb:pack  # Empaqueta como .mcpb para Claude Desktop
```

Tras editar cualquier archivo en `src/`, ejecuta `pnpm run build` antes de probar cambios. El binario que Claude Code/Desktop lanza es `dist/index.js`.

## Troubleshooting

**`Error: schema "X" is not allowed`** — añade `X` a `DB_SCHEMAS` (o déjalo vacío para permitir todos los no-sistema).

**`statement timeout`** — la query supera 30 s. Usa `postgres_explain_query` con `analyze=false` primero, o filtra por una columna indexada.

**`self-signed certificate` en RDS / Supabase** — establece `DB_SSL=true`. Solo baja `DB_SSL_REJECT_UNAUTHORIZED=false` si el proveedor usa cert auto-firmado.

**Claude Code no ve las tools** — verifica con `claude mcp list` que `postgres` aparece como `connected`. Si no, `claude mcp get postgres` te muestra el comando registrado; comprueba que la ruta absoluta a `dist/index.js` es correcta y que el build está actualizado.

**Query devuelve `has_more: true`** — vuelve a llamar la tool pasando `offset = next_offset`. Las listas están paginadas para no inflar el contexto.

## Licencia

MIT
