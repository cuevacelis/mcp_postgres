# MCP PostgreSQL — UPCH

Servidor MCP (Model Context Protocol) que expone herramientas de introspección y consulta de solo lectura sobre bases de datos PostgreSQL para Claude Code.

## Herramientas disponibles

| Herramienta | Descripción |
|-------------|-------------|
| `list_schemas` | Lista todos los esquemas accesibles |
| `list_tables` | Lista tablas de un esquema con conteo de columnas |
| `describe_table` | Estructura completa: columnas, constraints e índices |
| `list_functions` | Funciones/procedimientos con firma y tipo de retorno |
| `list_triggers` | Triggers con tabla, evento y timing |
| `query_table` | SELECT simple en una sola tabla con WHERE y LIMIT |
| `execute_query` | Consultas avanzadas: JOINs, CTEs, subqueries, agregaciones |
| `get_function_definition` | Código fuente de una función almacenada |
| `get_trigger_definition` | Definición completa de un trigger |

## Instalación

```bash
pnpm install
pnpm run build
```

## Configuración

Copia `.env.example` a `.env` y completa los valores:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=nombre_base_datos
DB_USER=usuario
DB_PASSWORD=contraseña
DB_SSL=false              # true para bases de datos en la nube (AWS RDS)
DB_SCHEMAS=public         # Esquemas permitidos, separados por coma. Vacío = todos
DEFAULT_LIMIT=5           # Límite por defecto de filas (máximo absoluto: 100)
```

### Entornos preconfigurados

El repositorio incluye archivos `.env-*` para distintos entornos. Para cambiar de entorno copia el archivo correspondiente a `.env`:

```bash
cp .env-ecosistema-prd .env
cp .env-db-admision-tst .env
```

## Integración con Claude Code

Agrega el servidor al archivo de configuración MCP de Claude Code (`~/.claude.json` o la configuración del proyecto):

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

Alternativamente, si usas `.env`, basta con apuntar al `dist/index.js` sin pasar `env` en la configuración.

## Verificar conectividad

```bash
npx tsx test-connection.ts
```

Muestra la configuración activa, prueba la conexión, lista esquemas y las primeras 5 tablas del primer esquema configurado.

## Seguridad

- **Filtrado de esquemas:** `DB_SCHEMAS` restringe el acceso a nivel de aplicación y vía `search_path` en PostgreSQL.
- **Solo lectura:** `execute_query` valida que la consulta comience con `SELECT` o `WITH` y bloquea keywords de modificación (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `GRANT`, `REVOKE`, `EXECUTE`, `COPY`) usando regex con word boundaries.
- **Límite de filas:** máximo 100 filas por consulta; se inyecta o reduce el `LIMIT` automáticamente.
- **Timeouts:** 10 s para establecer conexión, 30 s de `statement_timeout` en `execute_query`.
