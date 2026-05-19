# MCP PostgreSQL

Servidor MCP (Model Context Protocol) que expone herramientas de introspección y consulta de solo lectura sobre bases de datos PostgreSQL.

## Herramientas disponibles

| Herramienta | Descripción |
|-------------|-------------|
| `postgres_list_schemas` | Lista todos los esquemas accesibles |
| `postgres_list_tables` | Lista tablas de un esquema con conteo de columnas |
| `postgres_describe_table` | Estructura completa: columnas, constraints e índices |
| `postgres_list_functions` | Funciones/procedimientos con firma y tipo de retorno |
| `postgres_list_triggers` | Triggers con tabla, evento y timing |
| `postgres_query_table` | SELECT seguro en una tabla con filtros estructurados y LIMIT |
| `postgres_execute_query` | Consultas avanzadas de solo lectura: JOINs, CTEs, subqueries, agregaciones |
| `postgres_get_function_definition` | Código fuente de una función almacenada (con soporte de sobrecarga) |
| `postgres_get_trigger_definition` | Definición completa de un trigger |

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
DB_SSL_REJECT_UNAUTHORIZED=true  # recomendado en producción
DB_SCHEMAS=public         # Esquemas permitidos, separados por coma. Vacío = todos
DEFAULT_LIMIT=5           # Límite por defecto de filas (máximo absoluto: 100)
```

### Entornos preconfigurados

El repositorio incluye archivos `.env.*` para distintos entornos. Para cambiar de entorno copia el archivo correspondiente a `.env`:

```bash
cp .env.ecosistema-prd .env
cp .env.db-admision-tst .env
```

## Integración MCP

Agrega el servidor al archivo de configuración MCP de tu cliente:

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

- **Filtrado de esquemas:** `DB_SCHEMAS` restringe el acceso a nivel de aplicación y vía `search_path` local por consulta.
- **Query table segura:** `postgres_query_table` usa columnas/filtros estructurados y parámetros SQL para evitar inyección.
- **Solo lectura reforzada:** `postgres_execute_query` corre en `READ ONLY transaction`, limita a una sola sentencia y mantiene validaciones de texto.
- **Límite de filas:** máximo 100 filas por consulta; se inyecta o reduce el `LIMIT` automáticamente.
- **TLS seguro por defecto:** cuando `DB_SSL=true`, `DB_SSL_REJECT_UNAUTHORIZED=true` por defecto.
- **Timeouts:** 10 s para establecer conexión, 30 s de `statement_timeout` por consulta.
