# Supabase Edge Functions — copia de referencia

Este repo es el de Netlify (la web estática: `index.html`, `sw.js`, `images/`). Las funciones
de aquí abajo **no las despliega Netlify** — viven en Supabase y se suben a mano, pegando el
contenido de cada `index.ts` en el editor de esa función concreta en el dashboard de Supabase
(Project → Edge Functions → `<nombre>` → código). No hay CLI ni CI conectado a este repo para
Supabase, así que **commitear aquí NO despliega nada por sí solo**.

Esta carpeta existe solo para que haya una copia versionada y persistente de cada función —
antes se excluía del repo a propósito (`supabase/` en `.gitignore`), lo que obligaba a pedir el
archivo de nuevo en cada sesión nueva porque no quedaba ningún rastro entre una conversación y la
siguiente. Ahora, cada vez que se edite una de estas funciones, el flujo es:

1. Editar el `.ts` correspondiente aquí en el repo.
2. Commitear y pushear (igual que con `index.html`).
3. Pegar el contenido actualizado en el dashboard de Supabase para desplegarlo de verdad.

Y si el usuario actualiza algo directamente en Supabase sin pasar por aquí, hay que pedirle el
archivo una vez más para poner este repo al día — pero solo esa vez, no en cada sesión.

## Funciones

- `quiniela-jornada/` — trae los partidos de la jornada activa o de una histórica (Eduardo
  Losilla + football-data.org/ESPN como refuerzo de día/hora y marcador en vivo).
- `quick-task/` — notificaciones push puntuales y el flujo de confirmar apertura/salto de jornada
  (llamado desde el botón de Felix en la app).
- `cron-resultados/` — se dispara por cron en Supabase para revisar resultados periódicamente.
