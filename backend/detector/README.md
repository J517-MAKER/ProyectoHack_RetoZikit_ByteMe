# Detector sobre datos reales (kit Zikit)

Motor que corre sobre la telemetría real del kit de datos y distingue una
**falla real** del ruido normal del negocio, con prioridad en **cero falsas alarmas**.
Enfocado en el cliente **gramo** (distribuidora de alimentos).

## Piezas

- `dataset.py` — lee `metricas.csv`, `contexto.md` y las etiquetas de solución. Del
  contexto extrae las **ventanas esperadas** (backups, promo, snapshot).
- `motor.py` — detector. Cuenta señales **sostenidas** en una ventana móvil
  (RAM, latencia, errores) y filtra los picos que caen en ventanas esperadas.
- `evaluacion.py` — compara las detecciones contra la solución y reporta recall,
  falsas alarmas y anticipación.

## Resultado (10 corridas etiquetadas de gramo, 30 fallas reales)

- **Recall: 100 %** (30/30 fallas reales detectadas)
- **Falsas alarmas: 0**
- **Anticipación: ~60 min** antes de la etiqueta (que marca el pico)

En las 44 corridas sin etiqueta (conjunto de prueba oculto) el detector produce
3 avisos por corrida de forma consistente, sin ráfagas de falsas alarmas.

## Cómo se distingue real de ruido

Aprendido de los datos: los **minutos sueltos no sirven** (el tráfico normal tiene
picos de latencia >230 ms, 94 % de RAM o 14 errores en un minuto aislado). Una falla
real se delata por señales **sostenidas**:

| Falla | Firma sostenida |
|---|---|
| `fuga_memoria_worker` | RAM sube gradual y se sostiene ≥82 % |
| `agotamiento_pool_inventario` | latencia sostenida muy alta (~220 ms) |
| `trafico_hostil_lento` | latencia alta **+** errores, juntos y sostenidos |

Más el **filtro de contexto**: un pico dentro de una ventana anunciada (backup
nocturno, promo 2x1, snapshot de inventario) nunca genera aviso.

## Uso

```bash
# Con la muestra incluida (corrida_01 de gramo):
cd backend/detector
python evaluacion.py gramo

# Con el kit completo (clónalo aparte):
ZIKIT_DATASET=/ruta/a/zikit-dataset python evaluacion.py gramo -v
```
