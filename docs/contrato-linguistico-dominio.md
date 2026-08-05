# Contrato lingüístico de dominio — La Dieci

Estado: **ACTIVO**. Slice: ONDA 0 (guardrail, sin cambios de runtime).

Este documento congela formalmente el idioma autorizado para el dominio de
producto de La Dieci. Es idéntico en los dos repositorios staging:

- `ladieci-messa-staging-backend`
- `ladieci-messa-staging-frontend`

## Idioma autorizado

El idioma autorizado del dominio de producto es el **español**.

Deben estar en español:

- nombres de dominio;
- funciones y variables de dominio;
- tablas y columnas de dominio nuevas;
- RPC y actions nuevas;
- endpoints de dominio;
- payloads y claves JSON de dominio;
- estados y enums;
- códigos de error de aplicación;
- eventos de dominio;
- textos de UI.

## Inglés admitido

El inglés está admitido para terminología técnica estable, por ejemplo:

- `id`
- `created_at`
- `updated_at`
- `metadata`
- HTTP / JWT / RPC
- nombres de frameworks y librerías
- conceptos de infraestructura genéricos

Los nombres ingleses centrales que ya existen hoy, como:

- `service_sessions`
- `table_sessions`
- `payment_transactions`
- `payment_allocations`

están clasificados como **legado técnico tolerado temporalmente**. No deben
presentarse como el destino lingüístico definitivo y no deben renombrarse sin
una migration dedicada.

## Italiano legado

Los términos italianos existentes son legado activo o histórico.

No deben:

- copiarse en nuevos contratos;
- usarse como modelo para funciones nuevas;
- generar nuevos alias;
- renombrarse a ciegas.

Las migrations y los rollbacks históricos con `messa_*` permanecen
inmutables.

## Glosario autorizado

Base normativa. Describe el destino futuro del dominio; **no autoriza ningún
rename de runtime en este slice**.

| Concepto | Término autorizado |
|---|---|
| servicio operativo | `servicio` |
| sesión de servicio | `sesion_servicio` |
| cierre de servicio | `cierre_servicio` |
| resumen de cierre de servicio | `resumen_cierre_servicio` |
| orden | `orden` |
| historial de órdenes | `historial_ordenes` |
| estado de la orden | `estado_orden` |
| mesa | `mesa` |
| sesión de mesa | `sesion_mesa` |
| comanda | `comanda` |
| línea de comanda | `linea_comanda` |
| cubiertos | `cubiertos` |
| reserva | `reserva` |
| pago | `pago` |
| transacción de pago | `transaccion_pago` |
| asignación de pago | `asignacion_pago` |
| cocina | `cocina` |
| listo | `listo` |
| retiro (pickup) | `recogida` |
| domicilio | `domicilio` |
| repartidor | `repartidor` |
| servicio de almuerzo | `almuerzo` |
| servicio de cena | `cena` |
| fecha operativa | `fecha_operativa` |
| historial de conversaciones | `historial_conversaciones` |

### Decisiones obligatorias

- usar `servicio`, no sustituirlo por `turno`;
- mantener `orden` como concepto autorizado;
- no introducir `pedido`;
- usar `mesa`, nunca `messa`;
- usar `cocina`, nunca `cucina`;
- usar `recogida`, no `ritiro`;
- usar `almuerzo` y `cena`, no `pranzo` y `sera`.

## Guardrail automático

Cada repositorio implementa `scripts/check-domain-language.js`
(`npm run check:domain-language`), que:

1. escanea el árbol completo de código fuente (`.js`, `.jsx`, `.mjs`, `.ts`,
   `.tsx`, `.sql`) buscando una lista fija de términos italianos, con
   reconocimiento de límites de palabra en camelCase, PascalCase, snake_case,
   kebab-case y strings de action/error/status;
2. compara el resultado contra una baseline versionada
   (`config/domain-language-legacy-baseline.json`) que registra la deuda
   legada actual por archivo y término — un aumento respecto a la baseline
   falla, una disminución siempre se permite;
3. cuando hay un diff Git disponible (working tree, staged, o un rango
   `--base`/`--head` explícito para CI), revisa además solo las líneas
   añadidas, para detectar el caso en que un término se borra de un lugar y
   se añade en otro sin cambiar el conteo total.

### Excepciones

Una única excepción local por línea:

```
// language-guard: allow-legacy <motivo>
```

Debe estar en la misma línea o en la línea inmediatamente anterior, debe
llevar un motivo no vacío, y solo vale para esa línea. Una excepción sin
motivo hace fallar el control. No se debe usar para ocultar deuda nueva —
eso lo gestiona la baseline.

### Alcance excluido del guardrail

El guardrail cubre código fuente ejecutable — no prosa libre en archivos
Markdown (informes, especificaciones, documentación de trabajo), que no
forma parte del contrato de runtime descrito arriba.

Excepciones de ruta, estrictas y explícitas:

- la familia histórica de migrations `messa_*` (V3-H/V3-I/V3-J/V3-K,
  incluyendo sus ROLLBACK) y los tests estáticos dedicados que verifican
  esas migrations históricas específicas;
- el código fuente del propio guardrail, que necesariamente contiene la
  lista de términos bloqueados como dato literal.

No se excluyen directorios completos de `migrations` ni `tests`: solo los
archivos históricos puntuales listados arriba.
