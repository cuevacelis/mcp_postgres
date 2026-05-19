# MCP PostgreSQL

Servidor MCP (Model Context Protocol) que expone introspección y consulta de solo lectura sobre bases de datos PostgreSQL. Diseñado para alimentar de contexto a Claude (Claude Code, Claude Desktop) sin riesgo de escritura.

## Herramientas (13)

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

### Consulta

| Tool | Descripción |
|------|-------------|
| `postgres_query_table` | SELECT seguro sobre una sola tabla con filtros estructurados. |
| `postgres_execute_query` | SELECT/WITH avanzado (JOINs, CTEs, agregaciones). Single-statement, READ ONLY. |
| `postgres_explain_query` | EXPLAIN / EXPLAIN ANALYZE de un SELECT — perfila planes antes de ejecutar. |
| `postgres_get_table_stats` | Tamaño total/tabla/índices/toast, vacuum/analyze, índices con `idx_scan = 0`. |

Todas las tools llevan `readOnlyHint: true`, `destructiveHint: false` y `outputSchema` zod para `structuredContent`. Los errores recuperables se devuelven como `{ isError: true, content }`, no como excepciones de protocolo.

## Resources

URIs navegables que el host puede consumir como contexto:

| URI template | Contenido |
|--------------|-----------|
| `postgres://schema/{schema}` | Resumen de un esquema: tablas, vistas, funciones, triggers, conteos. |
| `postgres://table/{schema}/{table}` | Estructura completa de una tabla (cols + constraints + índices). |

## Prompts (slash commands)

| Prompt | Argumentos | Propósito |
|--------|------------|-----------|
| `audit-table` | `schema`, `table` | Auditoría estructurada: schema, storage, sample, triggers, riesgos. |
| `find-tables` | `pattern` | Encuentra columnas/tablas por patrón fuzzy. |
| `explain-foreign-keys` | `schema` | Mapa textual de FKs (hubs, huérfanos). |
| `profile-slow-query` | `sql` | EXPLAIN ANALYZE + recomendaciones priorizadas. |

## Instalación

```bash
pnpm install
pnpm run build
```

## Configuración

Copia `.env.example` a `.env`:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=nombre_base_datos
DB_USER=usuario
DB_PASSWORD=contraseña
DB_SSL=false              # true para bases de datos en la nube (AWS RDS)
DB_SSL_REJECT_UNAUTHORIZED=true
DB_SCHEMAS=public         # Esquemas permitidos, separados por coma. Vacío = todos
DEFAULT_LIMIT=5
```

### Entornos preconfigurados

```bash
cp .env.ecosistema-prd .env
cp .env.db-admision-tst .env
```

## Integración con Claude Code

### Opción A — `claude mcp add` (recomendado)

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

Variantes útiles:

- Para que tome el `.env` del repo y no pases credenciales al CLI, omite los `--env` y asegúrate de que `dist/index.js` arranque desde el directorio del proyecto:

  ```bash
  claude mcp add --transport stdio postgres \
    -- node /ruta/absoluta/al/proyecto/dist/index.js
  ```

- Para scope global (todos los proyectos):

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

## Verificar conectividad

```bash
npx tsx test-connection.ts
```

## Seguridad

- **Filtrado de esquemas**: `DB_SCHEMAS` restringe acceso a nivel de aplicación; además `postgres_execute_query` ajusta `search_path` local por consulta.
- **Query table segura**: `postgres_query_table` usa columnas/filtros estructurados y parámetros SQL — no concatena strings.
- **Solo lectura reforzada**: `postgres_execute_query` y `postgres_explain_query` corren bajo `SET TRANSACTION READ ONLY` con `statement_timeout = 30s`.
- **Single-statement**: rechaza queries con `;` interno y palabras clave de escritura.
- **Límite de filas**: máximo 100 filas por consulta; se inyecta o clampa el `LIMIT` automáticamente.
- **TLS seguro por defecto**: cuando `DB_SSL=true`, `DB_SSL_REJECT_UNAUTHORIZED=true` por defecto.
- **Timeouts**: 10 s para establecer conexión.

## Desarrollo

```bash
pnpm run build      # Compila TypeScript → dist/
pnpm run dev        # Watch mode
pnpm start          # Ejecuta el servidor compilado
```
