---
name: uniora-release
description: Versionado y publicación de UNIORA. Úsala SOLO cuando la persona pida cortar, preparar o publicar un release (subir versión, crear el tag, publicar en npm), o pregunte qué número de versión toca. NO se usa en un cambio normal: un cambio no sube la versión, solo anota su entrada bajo "Unreleased" del CHANGELOG. Define SemVer (parche / menor / mayor), el bump en bloque de los 15 paquetes, las comprobaciones previas y los enlaces que siempre se le entregan a la persona para crear el tag y aprobar la publicación en Actions.
---

# UNIORA: versionado y publicación

**Un cambio no sube la versión; un release sí.** Mientras se trabaja en una función o una corrección solo se escribe su entrada bajo `## Unreleased` del `CHANGELOG.md` y **no se toca ningún `package.json`**. Esta skill se usa una sola vez por release, cuando la persona lo pide.

## 1. Qué número toca (SemVer)

El número sale de lo que haya acumulado `Unreleased`, siguiendo [SemVer](https://semver.org) (`MAYOR.MENOR.PARCHE`):

| Qué contiene lo acumulado | Sube | Ejemplo |
| --- | --- | --- |
| Solo **correcciones** de errores, sin API ni datos nuevos (el comportamiento documentado no cambia) | PARCHE | `1.0.0` → `1.0.1` |
| **Funciones nuevas compatibles**: campo, ruta, scope, error, evento, export o migración nuevos, y todo lo opcional | MENOR | `1.0.1` → `1.1.0` (y el parche vuelve a `0`) |
| **Cambio incompatible**: quitar o renombrar algo, hacer obligatorio un campo, cambiar un significado | MAYOR, anunciado como incompatible en el CHANGELOG (desde `1.0.0` un cambio incompatible nunca sale en un MENOR) | `1.4.2` → `2.0.0` |

- Si hay de varias clases, manda la más alta. Una corrección que además añade un campo a la API es MENOR, no PARCHE.
- Un PARCHE nunca añade ni quita superficie pública: si el cambio añade un campo o una migración, no es un parche aunque "arregle algo".
- Dile a la persona qué número propones y por qué (qué hay en `Unreleased`). Si duda, decide ella.

## 2. Preparar el release

1. Sube la versión en los **15 paquetes publicables a la vez** (el release es en bloque, todos comparten versión; `@uniora/server` y `@uniora/client` salen juntos) y cambia el encabezado `## Unreleased` del CHANGELOG por `## X.Y.Z - AAAA-MM-DD`. Se hace en un commit `chore(release): X.Y.Z`, que va por PR y se fusiona en `main`.
2. Comprueba, con todo en verde:
   ```bash
   pnpm install --frozen-lockfile
   pnpm -r build && pnpm check:packages        # empaquetado: publint y attw de cada paquete
   node scripts/check-release.mjs vX.Y.Z        # tag, versiones y metadatos coherentes
   ```
3. El CI del PR debe estar en verde y el PR fusionado. **El tag va siempre sobre un commit que ya está en `main`**, nunca sobre una rama.

## 3. Publicar: la persona crea el tag y aprueba (siempre)

Publicar en npm es irreversible (una versión publicada no se reutiliza) y es decisión de la persona. Además, el proxy de las sesiones rechaza el push de tags (`403`). **Nunca empujes el tag.** Tu entrega final incluye siempre estos enlaces, ya rellenos (sustituye `X.Y.Z`):

1. **Crear el tag y el release**: `https://github.com/CodexSploitx/uniora/releases/new?tag=vX.Y.Z&target=main&title=vX.Y.Z`
   Crear el release crea el tag y el tag dispara el workflow `Release`. Dile el SHA de `main` sobre el que debe caer y de dónde copiar las notas (la sección `X.Y.Z` del CHANGELOG).
2. **El workflow que publica**: `https://github.com/CodexSploitx/uniora/actions/workflows/release.yml`
   Qué hará: repite el CI completo y luego `npm publish` (environment `npm`, con provenance, tras comprobar tag, versiones y metadatos con `check-release.mjs`). Publica los 15 paquetes y omite lo ya publicado.
3. **Dónde aprobar**: si el environment `npm` tiene revisores obligatorios, el job espera en *Review deployments → Approve*. Configuración: `https://github.com/CodexSploitx/uniora/settings/environments`
4. **Para comprobar el resultado**: `https://www.npmjs.com/package/@uniora/core` y `https://www.npmjs.com/package/@uniora/server` (y el resto si quiere).

## 4. Al terminar

- Recuérdale a la persona qué tiene que actualizar quien use UNIORA: subir los paquetes a `X.Y.Z` y correr `uniora migrate` si el release trae migraciones nuevas.
- Si algo falla a mitad de la publicación, **no se reutiliza la versión**: se corrige y sale la siguiente de parche.
