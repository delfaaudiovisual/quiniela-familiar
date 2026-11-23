// ============================================================
// SUPABASE EDGE FUNCTION: quiniela-jornada
// (sube este archivo a esa función concreta en el dashboard)
// ============================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EDU_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  "Accept": "text/html",
  "Accept-Language": "es-ES,es;q=0.9",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// ============ UTILS ============
function capitalize(s: string): string {
  if (!s) return "";
  const t = s.trim();
  if (/^ee\.?uu\.?$/i.test(t) || /^eeuu$/i.test(t)) return "EE.UU.";
  const fixes: Record<string, string> = {
    "arabia saudi": "Arabia Saudí", "iran": "Irán", "belgica": "Bélgica",
    "tunez": "Túnez", "japon": "Japón", "turquia": "Turquía", "haiti": "Haití",
  };
  if (fixes[t.toLowerCase()]) return fixes[t.toLowerCase()];
  return t.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

function signoFromScore(h: number, a: number): string {
  return h > a ? "1" : h === a ? "X" : "2";
}

function getStat(stats: any[], name: string): number {
  return stats.find((s: any) => s.name === name)?.value || 0;
}

// ============ RESULTADOS EN DIRECTO (LaLiga Primera+Segunda) ============
// La Quiniela mezcla partidos de Primera y Segunda, y Eduardo Losilla escribe los nombres
// de forma abreviada ("At.madrid", "Ath.club", "R.oviedo"...) — en vez de un diccionario fijo
// de nombres exactos (frágil), se comparan por "tokens" significativos compartidos.
// "deportivo" NO va aquí aunque parezca un prefijo genérico como "real" o "club": para el
// Deportivo de La Coruña es el nombre entero del equipo (Losilla lo escribe solo "Deportivo"),
// así que quitarlo lo dejaba sin ningún token y nunca emparejaba con football-data/ESPN — se
// quedaba sin marcador en vivo ni día/hora en toda jornada en la que jugara.
const NOMBRE_STOPWORDS = new Set([
  "cf", "fc", "cd", "ca", "rc", "rcd", "ud", "sd", "club", "de", "balompie", "futbol", "real",
]);

function teamTokens(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // quitar acentos
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(w => w.length >= 3 && !NOMBRE_STOPWORDS.has(w));
}

function teamsMatch(a: string, b: string): boolean {
  const ta = teamTokens(a), tb = teamTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  return ta.some(x => tb.some(y => x.includes(y) || y.includes(x)));
}

// `estado` es el status crudo que da la fuente, solo para depurar/loguear. `genuinoSuspendido`
// es la señal de verdad que se usa para vetar a Losilla: true SOLO cuando la fuente dice de forma
// explícita que el partido está aplazado/suspendido/cancelado — NUNCA por "todavía no tiene
// marcador", que también es cierto para un partido que sencillamente no ha empezado o para el que
// la fuente externa aún no se ha actualizado (retraso normal de la API justo tras el pitido
// final). Confundir esas dos cosas fue justo el bug del 22 de noviembre: 5 partidos de un mismo
// domingo salieron en amarillo porque football-data/ESPN iban con retraso, no porque estuvieran
// realmente suspendidos — uno de ellos (R.Sociedad-Sevilla femenino) ya tenía resultado real
// (1-0) en Losilla.
type LiveScore = { home: string; away: string; marcador: string | null; c: boolean; r: string | null; dia?: string | null; hora?: string | null; estado?: string | null; genuinoSuspendido?: boolean };

// Busca el marcador (o el día/hora) de un partido de Losilla (local/visitante) dentro de la lista
// traída de football-data/ESPN. Los partidos femeninos ("... (f)") se buscan aparte, quitando el
// sufijo, porque la lista de partidos masculinos y femenina viajan juntas en el mismo array pero
// bajo nombres de equipo distintos (sin "(f)" en la fuente).
function findLiveScore(scores: LiveScore[], local: string, visitante: string): LiveScore | undefined {
  const esFemenino = local.includes('(f)') || visitante.includes('(f)');
  if (esFemenino) {
    const stripF = (s: string) => s.replace(/\s*\(f\)\s*$/i, '').trim();
    return scores.find(s => teamsMatch(s.home, stripF(local)) && teamsMatch(s.away, stripF(visitante)));
  }
  return scores.find(s => teamsMatch(s.home, local) && teamsMatch(s.away, visitante));
}

// ¿Esta fuente dice EXPLÍCITAMENTE que el partido está aplazado/suspendido/cancelado? Se usa como
// veto al "finalizado" de Losilla, cuya única pista es que el hueco de la hora esté oculto en el
// HTML — y ese hueco también se oculta en un partido APLAZADO (no hay hora que mostrar), no solo
// en uno ya jugado. Pero ojo: se exige el status explícito (ver genuinoSuspendido), NO basta con
// "esta fuente no tiene marcador todavía" — eso también pasa con un partido que sencillamente no
// ha empezado o que la fuente externa aún no ha actualizado, y vetar a Losilla en ese caso tira
// abajo un resultado que en realidad ya era correcto.
function postergadoSegunFuente(live: LiveScore | undefined): boolean {
  return !!live && live.genuinoSuspendido === true;
}

const FBDATA_KEY = Deno.env.get("FBDATA_KEY") || "53cd7637fb9648ae9915bceb49065fef";

// Día de la semana (mismo formato de 3 letras que usa cron-resultados: JUE/VIE/SAB/DOM/LUN/MAR/MIE)
// y hora "HH:MM", los dos en huso horario de España — el campo utcDate de football-data (y el
// `date` de ESPN) vienen en UTC, así que hay que convertir o un partido de las 21:00 español
// podría salir marcado con el día siguiente.
const DIA_ABBR: Record<string, string> = {
  Thursday: 'JUE', Friday: 'VIE', Saturday: 'SAB', Sunday: 'DOM', Monday: 'LUN', Tuesday: 'MAR', Wednesday: 'MIE',
};
function diaHoraDesdeISO(iso: string): { dia: string | null; hora: string | null } {
  try {
    const d = new Date(iso);
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Madrid', weekday: 'long' }).format(d);
    const hora = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    return { dia: DIA_ABBR[weekday] || null, hora };
  } catch {
    return { dia: null, hora: null };
  }
}

// Ventana de fechas común (no solo "hoy") para todas las fuentes de horario — sirve tanto para
// el marcador en vivo de la jornada actual como para el día/hora de la previa de la siguiente
// jornada, que se pide días antes de que empiece.
function ventanaFechas(): { dateFrom: string; dateTo: string } {
  const hoy = new Date();
  const desde = new Date(hoy.getTime() - 3 * 24 * 60 * 60 * 1000);
  const hasta = new Date(hoy.getTime() + 14 * 24 * 60 * 60 * 1000);
  return { dateFrom: desde.toISOString().split('T')[0], dateTo: hasta.toISOString().split('T')[0] };
}

// Trae partidos de UNA competición de football-data.org. Devuelve null (no []) si la petición
// falló del todo (red, límite de peticiones...), para poder distinguir "esta competición no
// tiene partidos en la ventana" de "no se pudo ni preguntar" — así el que llama sabe si merece
// la pena rellenar el hueco con ESPN.
async function getFBDCompeticion(competition: string): Promise<LiveScore[] | null> {
  const { dateFrom, dateTo } = ventanaFechas();
  try {
    const res = await fetch(
      `https://api.football-data.org/v4/competitions/${competition}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`,
      { headers: { "X-Auth-Token": FBDATA_KEY } }
    );
    if (!res.ok) {
      console.error(`football-data.org error (${competition}):`, res.status);
      return null;
    }
    const data = await res.json();
    return (data.matches || []).map((match: any) => {
      const homeName = match.homeTeam?.name || match.homeTeam?.shortName || '';
      const awayName = match.awayTeam?.name || match.awayTeam?.shortName || '';
      const homeScore = match.score?.fullTime?.home ?? match.score?.halfTime?.home ?? 0;
      const awayScore = match.score?.fullTime?.away ?? match.score?.halfTime?.away ?? 0;
      const status = match.status;
      const isLive = status === 'IN_PLAY' || status === 'PAUSED';
      const isFinal = status === 'FINISHED';
      // football-data.org SÍ distingue estados reales de interrupción de "todavía no ha
      // empezado"/"en juego" — solo estos tres cuentan como una suspensión/aplazamiento genuino.
      const genuinoSuspendido = status === 'SUSPENDED' || status === 'POSTPONED' || status === 'CANCELLED';
      const { dia, hora } = match.utcDate ? diaHoraDesdeISO(match.utcDate) : { dia: null, hora: null };
      return {
        home: homeName, away: awayName,
        marcador: (isLive || isFinal) ? `${homeScore}-${awayScore}${isLive ? ' 🔴' : ''}` : null,
        c: isFinal, r: isFinal ? signoFromScore(homeScore, awayScore) : null,
        dia, hora, estado: status || null, genuinoSuspendido,
      };
    });
  } catch (e) {
    console.error(`football-data.org error (${competition}):`, e);
    return null;
  }
}

// El endpoint site.api.espn.com/.../scoreboard devuelve 403 para esta función (con y sin rango
// de fechas — probado con logs reales), casi seguro bloqueando por IP al ser una API no oficial.
// La web pública ([www.espn.com](https://www.espn.com)) NO está bloqueada, y esa página trae todo el calendario ya
// incrustado como JSON dentro de un <script>window['__espnfitt__']={...}</script> — se extrae
// ese bloque (con conteo de llaves consciente de strings, no una regex frágil) en vez de
// scrapear HTML visual, así que no depende de nombres de clases CSS que puedan cambiar.
function extraerAsignacionJS(html: string, marcador: string): any | null {
  const idx = html.indexOf(marcador);
  if (idx === -1) return null;
  const start = idx + marcador.length;
  if (html[start] !== '{') return null;
  let depth = 0, inStr = false, strCh = '', esc = false, i = start;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === strCh) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  try {
    return JSON.parse(html.slice(start, i));
  } catch (e) {
    console.error('Error parseando JSON de ESPN:', e);
    return null;
  }
}

// Trae partidos de una o varias ligas de ESPN (esp.1 Primera, esp.2 Segunda, esp.w.1 Liga F) vía
// la página pública de calendario — sin parámetro de fechas de momento, la propia página ya
// muestra por defecto una ventana de unos días alrededor de hoy (suficiente para la jornada
// actual y un adelanto de la siguiente).
async function getESPNLigas(leagues: string[]): Promise<LiveScore[]> {
  const scores: LiveScore[] = [];
  for (const league of leagues) {
    try {
      const res = await fetch(
        `https://www.espn.com/soccer/schedule/_/league/${league}`,
        { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" } }
      );
      if (!res.ok) {
        console.error(`ESPN schedule page error (${league}):`, res.status);
        continue;
      }
      const html = await res.text();
      const data = extraerAsignacionJS(html, "window['__espnfitt__']=");
      const events = data?.page?.content?.events;
      if (!events) {
        console.error(`ESPN schedule page (${league}): no se encontró el JSON de eventos`);
        continue;
      }

      for (const dayEvents of Object.values(events) as any[]) {
        for (const ev of (dayEvents || [])) {
          const home = ev.competitors?.find((c: any) => c.isHome);
          const away = ev.competitors?.find((c: any) => !c.isHome);
          if (!home || !away) continue;

          const state = ev.status?.state; // 'pre' | 'in' | 'post' — SOLO estos tres, no hay un
          // estado propio de "aplazado"/"suspendido": un partido pospuesto también aparece como
          // 'pre' (igual que uno que sencillamente no ha empezado todavía), así que ESPN no puede
          // distinguir entre las dos cosas. genuinoSuspendido se deja siempre false aquí — nunca
          // vetamos a Losilla con datos de ESPN para esto (solo football-data.org, que sí separa
          // SUSPENDED/POSTPONED/CANCELLED de SCHEDULED).
          const isLive = state === 'in';
          const isFinal = state === 'post';
          const homeScore = Number(home.score ?? 0);
          const awayScore = Number(away.score ?? 0);
          const { dia, hora } = ev.date ? diaHoraDesdeISO(ev.date) : { dia: null, hora: null };

          scores.push({
            home: home.displayName || home.shortDisplayName || '',
            away: away.displayName || away.shortDisplayName || '',
            marcador: (isLive || isFinal) ? `${homeScore}-${awayScore}${isLive ? ' 🔴' : ''}` : null,
            c: isFinal, r: isFinal ? signoFromScore(homeScore, awayScore) : null,
            dia, hora, estado: state || null, genuinoSuspendido: false,
          });
        }
      }
    } catch(e) {
      console.error(`ESPN schedule page error (${league}):`, e);
    }
  }
  return scores;
}

// football-data.org primero para Primera/Segunda (trae racha/tabla cruzadas por ID, más
// fiable), y SOLO se rellena con ESPN la competición concreta que haya fallado o venga vacía —
// antes, si Primera funcionaba pero Segunda fallaba (p.ej. límite de peticiones de la API
// gratuita), como el array total no quedaba vacío nunca se probaba ESPN y Segunda se quedaba sin
// día/hora entera aunque Primera fuera perfecta. La Liga F no la cubre football-data.org en el
// plan gratuito, así que siempre se trae de ESPN.
async function getPartidosConHorario(): Promise<LiveScore[]> {
  const [pd, sd] = await Promise.all([getFBDCompeticion('PD'), getFBDCompeticion('SD')]);
  let scores: LiveScore[] = [...(pd || []), ...(sd || [])];

  // ESPN (site.api.espn.com/.../scoreboard) devuelve 403 para esp.1/esp.2/esp.w.1 por igual
  // (comprobado con logs reales) — no es un problema de Segunda o Liga F en concreto, sino que
  // ese endpoint bloquea las peticiones de esta función entera (probablemente por IP, al ser una
  // API no oficial). Se deja la llamada igualmente por si ESPN levanta el bloqueo más adelante,
  // pero hoy por hoy football-data.org es la única fuente real: cubre Primera, y Segunda solo si
  // algún día se paga el plan que la incluye (ahora mismo da 403 también, por plan gratuito).
  const espnFaltantes: string[] = ['esp.w.1']; // Liga F, siempre (football-data no la tiene)
  if (!pd || pd.length === 0) espnFaltantes.push('esp.1');
  if (!sd || sd.length === 0) espnFaltantes.push('esp.2');
  scores = scores.concat(await getESPNLigas(espnFaltantes));

  return scores;
}

// ============ EDUARDO LOSILLA — JORNADA ============
// Temporada que Losilla tiene cargada para esta página (ej. "25/26"). Sirve para detectar
// cuando el sitio todavía no ha publicado la temporada nueva y sigue devolviendo la anterior.
function parseTemporada(html: string): string | null {
  const m = html.match(/title="TEMPORADA (\d{2}\/\d{2})"/i);
  return m ? m[1] : null;
}

function parseEduLosilla(html: string): { jornadaNum: number | null, temporada: string | null, partidos: any[] } {
  const partidos: any[] = [];
  const jMatch = html.match(/JORNADA\s+(\d+)/i);
  const jornadaNum = jMatch ? parseInt(jMatch[1]) : null;
  const temporada = parseTemporada(html);
  const chunks = html.split('aria-label="Partido número ');

  const posicionesVistas = new Set<number>();
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i].substring(0, 3000);
    const posMatch = chunk.match(/^(\d+)"/);
    if (!posMatch) continue;
    const pos = parseInt(posMatch[1]);
    if (pos < 1 || pos > 14) continue;
    // Algunas jornadas (ej. "en vivo") repiten el bloque de cada partido dos veces en el HTML — nos quedamos con el primero
    if (posicionesVistas.has(pos)) continue;
    posicionesVistas.add(pos);
    const ariaMatch = chunk.match(/aria-label="([^"]+)\s+contra\s+([^"]+)"/i);
    if (!ariaMatch) continue;
    const local = capitalize(ariaMatch[1].trim());
    const visitante = capitalize(ariaMatch[2].trim());

    // Día de la semana (VIE/SAB/DOM/LUN...) — sirve para detectar jornadas raras
    const diaMatch = chunk.match(/time__day">([^<]+)</);
    const dia = diaMatch ? diaMatch[1].trim() : null;

    // Get official result from Losilla (closed only)
    const scoreMatch = chunk.match(/class="c-marcador-horario__match__score[^"]*"[^>]*>\s*(\d+)-(\d+)\s*<\/div>/);
    let r = null, c = false, marcador = null;
    if (scoreMatch) {
      const h = parseInt(scoreMatch[1]), a = parseInt(scoreMatch[2]);
      const isFinished = chunk.includes('c-marcador-horario__time" hidden=');
      if (isFinished) {
        r = signoFromScore(h, a);
        c = true;
        marcador = `${h}-${a}`;
      }
    }
    partidos.push({ posicion: pos, l: local, v: visitante, r, c, marcador, dia });
  }

  // Pleno (partido 15)
  const plenoIdx = html.indexOf('aria-label="Partido número 15"');
  if (plenoIdx > -1) {
    const plenoChunk = html.substring(plenoIdx, plenoIdx + 3000);
    const ariaMatches = [...plenoChunk.matchAll(/aria-label="([^"]+)\s+contra\s+([^"]+)"/gi)];
    let plenoLocal = "", plenoVisit = "";
    if (ariaMatches.length > 0) {
      plenoLocal = capitalize(ariaMatches[0][1].trim());
      plenoVisit = capitalize(ariaMatches[0][2].trim());
    }
    const plenoScore = plenoChunk.match(/class="c-marcador-horario__match__score[^"]*"[^>]*>\s*(\d+)-(\d+)\s*<\/div>/);
    const plenoFinished = plenoChunk.includes('c-marcador-horario__time" hidden=');
    // El Pleno al 15 es un partido real como cualquier otro (a veces el último de la jornada,
    // incluso el "de gala" que se juega más tarde) — necesita su propio día para que el gate de
    // cierre de jornada no lo ignore, igual que ya se hace con los 14 partidos normales.
    const plenoDiaMatch = plenoChunk.match(/time__day">([^<]+)</);
    const plenoDia = plenoDiaMatch ? plenoDiaMatch[1].trim() : null;
    partidos.push({
      posicion: 15, l: plenoLocal || "Pleno al 15", v: plenoVisit || "",
      r: null, c: !!(plenoScore && plenoFinished), pleno: true,
      marcador: plenoScore ? `${plenoScore[1]}-${plenoScore[2]}` : null,
      dia: plenoDia,
    });
  }

  return { jornadaNum, temporada, partidos: partidos.sort((a, b) => a.posicion - b.posicion) };
}

// Construye siempre una lista de 14 casillas fijas (1..14), en su posición real.
// Si un partido está suspendido y la web de Losilla deja de listarlo, esa casilla concreta
// queda "pendiente" (sin resultado) EN SU SITIO en vez de desaparecer y correr a las demás.
function regularByPosicion(partidos: any[], mapFn: (p: any) => any): any[] {
  const byPos = new Map(
    partidos.filter((p: any) => p.posicion >= 1 && p.posicion <= 14).map((p: any) => [p.posicion, p])
  );
  const regular = [];
  for (let pos = 1; pos <= 14; pos++) {
    const p = byPos.get(pos);
    regular.push(p ? mapFn(p) : { l: "?", v: "?", r: null, c: false, marcador: null, suspendido: true });
  }
  return regular;
}

async function fetchEscrutinio(jornada: number) {
  const res = await fetch(
    `https://www.eduardolosilla.es/quiniela/ayudas/escrutinio/jornada_${jornada}`,
    { headers: EDU_HEADERS }
  );
  if (!res.ok) return { partidos: [], jornadaNum: null, temporada: null };
  return parseEduLosilla(await res.text());
}

// Página de "Próximas" — a diferencia de /escrutinio/jornada_<N> (que pide un número concreto y,
// si esa jornada aún no existe para la temporada actual, puede caer de vuelta a una página vieja
// de OTRA temporada con el mismo número), esta URL fija siempre enseña la siguiente jornada real
// que todavía no se ha abierto, sin parámetro de número y sin ambigüedad de temporada — útil
// específicamente para "¿ya hay datos de la jornada siguiente?" cuando el escrutinio todavía no
// la tiene (Losilla publica el calendario completo de un boleto con más antelación de la que
// tarda en aparecer en escrutinio). No trae marcadores (nada se ha jugado todavía), así que estos
// partidos siempre salen con r/marcador a null — de sobra para evaluar jornadaValida y para la
// previa que ve Felix.
function parseEduProximas(html: string): { jornadaNum: number | null; partidos: any[] } {
  const partidos: any[] = [];
  const tituloMatch = html.match(/c-ayudas-proximas__tabla-partidos__titulo">\s*JORNADA\s+(\d+)/i);
  const jornadaNum = tituloMatch ? parseInt(tituloMatch[1]) : null;
  const chunks = html.split('aria-label="Partido número ');

  const posicionesVistas = new Set<number>();
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i].substring(0, 3000);
    const posMatch = chunk.match(/^(\d+)"/);
    if (!posMatch) continue;
    const pos = parseInt(posMatch[1]);
    if (pos < 1 || pos > 14) continue;
    if (posicionesVistas.has(pos)) continue;
    posicionesVistas.add(pos);
    const ariaMatch = chunk.match(/aria-label="([^"]+)\s+contra\s+([^"]+)"/i);
    if (!ariaMatch) continue;
    const local = capitalize(ariaMatch[1].trim());
    const visitante = capitalize(ariaMatch[2].trim());
    const diaMatch = chunk.match(/time__day">([^<]+)</);
    const dia = diaMatch ? diaMatch[1].trim() : null;
    const horaMatch = chunk.match(/time__hour">([^<]+)</);
    const hora = horaMatch ? horaMatch[1].trim() : null;
    partidos.push({ posicion: pos, l: local, v: visitante, dia, hora });
  }

  const plenoIdx = html.indexOf('aria-label="Partido número 15"');
  if (plenoIdx > -1) {
    const plenoChunk = html.substring(plenoIdx, plenoIdx + 3000);
    const ariaMatches = [...plenoChunk.matchAll(/aria-label="([^"]+)\s+contra\s+([^"]+)"/gi)];
    let plenoLocal = "", plenoVisit = "";
    if (ariaMatches.length > 0) {
      plenoLocal = capitalize(ariaMatches[0][1].trim());
      plenoVisit = capitalize(ariaMatches[0][2].trim());
    }
    const plenoDiaMatch = plenoChunk.match(/time__day">([^<]+)</);
    const plenoDia = plenoDiaMatch ? plenoDiaMatch[1].trim() : null;
    const plenoHoraMatch = plenoChunk.match(/time__hour">([^<]+)</);
    const plenoHora = plenoHoraMatch ? plenoHoraMatch[1].trim() : null;
    partidos.push({ posicion: 15, l: plenoLocal || "Pleno al 15", v: plenoVisit || "", pleno: true, dia: plenoDia, hora: plenoHora });
  }

  return { jornadaNum, partidos: partidos.sort((a, b) => a.posicion - b.posicion) };
}

async function fetchProximas(): Promise<{ jornadaNum: number | null; partidos: any[] }> {
  try {
    const res = await fetch(`https://www.eduardolosilla.es/quiniela/ayudas/proximas`, { headers: EDU_HEADERS });
    if (!res.ok) return { jornadaNum: null, partidos: [] };
    return parseEduProximas(await res.text());
  } catch (e) {
    console.error('Error fetching proximas:', e);
    return { jornadaNum: null, partidos: [] };
  }
}

// Construye la lista de 15 casillas (sin marcador, nada se ha jugado todavía) y evalúa
// jornadaValida a partir de los partidos de /proximas — compartido entre la rama jornadaHistorica
// (previa que ve el admin) y la rama por defecto (vista normal del jugador), que necesitan
// exactamente lo mismo cuando el escrutinio todavía no tiene la jornada publicada.
async function construirDesdeProximas(proximas: { partidos: any[] }) {
  const regular = regularByPosicion(proximas.partidos, (p: any) => ({
    l: p.l, v: p.v, r: null, c: false, marcador: null, suspendido: false, dia: p.dia || null, hora: p.hora || null,
  }));
  const pleno = proximas.partidos.find((p: any) => p.posicion === 15 || p.pleno);
  regular.push({ l: pleno?.l || "Pleno al 15", v: pleno?.v || "", r: null, c: false, pleno: true, marcador: null, suspendido: false, dia: pleno?.dia || null, hora: pleno?.hora || null });
  const { valida: jornadaValida, primeraCount } = await evaluarJornadaValida(proximas.partidos);
  return { regular, jornadaValida, primeraCount };
}

// Temporada LaLiga esperada ahora mismo, ej. "26/27" (cambia de año en julio, antes de que arranque la Liga)
function temporadaEsperada(): string {
  const now = new Date();
  const mes = now.getMonth() + 1; // 1-12
  const inicio = mes >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  const dosDigitos = (y: number) => String(y % 100).padStart(2, '0');
  return `${dosDigitos(inicio)}/${dosDigitos(inicio + 1)}`;
}

async function getJornadaActual(): Promise<number> {
  // Puede haber varias filas con esta clave (una por cada vez que se avanzó de jornada) —
  // nos quedamos con la de número de jornada más alto en vez de exigir que haya solo una,
  // así no revienta si queda alguna fila vieja sin borrar.
  const { data } = await supabase
    .from('jornada_estado')
    .select('valor')
    .eq('clave', 'jornada_actual')
    .order('jornada', { ascending: false })
    .limit(1)
    .maybeSingle();
  return parseInt(data?.valor || '69');
}

// ============ ESPN STANDINGS ============
async function getESPNStandings(league: string): Promise<any> {
  const res = await fetch(`https://site.api.espn.com/apis/v2/sports/soccer/${league}/standings`, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ESPN error for ${league}: HTTP ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
  }
  return await res.json();
}

// El endpoint de standings de ESPN no trae la racha reciente (comprobado: no existe el stat
// "form" para ninguna liga), y el de football-data.org sí tiene el campo "form" pero viene
// siempre `null` en el plan gratuito (es un dato premium). Así que la racha se calcula a mano
// a partir de los resultados reales de los últimos partidos.
//
// Importante: tabla Y racha se traen las dos de football-data.org (nunca mezclando con los
// nombres de ESPN) y se cruzan por el ID interno de equipo de football-data — probamos primero
// a cruzar por nombre y salían mezclas reales (ej. "Real Madrid" enganchaba con la racha de
// "Atlético de Madrid" porque los dos nombres comparten la palabra "Madrid" al normalizar).
// Cruzar por ID evita ese problema de raíz.
//
// PD=Primera, SD=Segunda. La Liga F no está en el plan gratuito de football-data.org, así que
// para "ligaf" se sigue usando solo ESPN (sin racha).
const FBD_COMPETITION_POR_TIPO: Record<string, string> = { liga1: 'PD', liga2: 'SD' };

type EquipoClasi = { pos: number; name: string; pts: number; pj: number; forma: string[] };

async function getFormaFromFBD(competition: string): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  try {
    const hoy = new Date();
    const desde = new Date(hoy.getTime() - 45 * 24 * 60 * 60 * 1000); // últimos 45 días — de sobra para 3 partidos
    const dateFrom = desde.toISOString().split('T')[0];
    const dateTo = hoy.toISOString().split('T')[0];
    const res = await fetch(
      `https://api.football-data.org/v4/competitions/${competition}/matches?status=FINISHED&dateFrom=${dateFrom}&dateTo=${dateTo}`,
      { headers: { "X-Auth-Token": FBDATA_KEY } }
    );
    if (!res.ok) {
      console.error(`football-data.org matches error (${competition}):`, res.status);
      return map;
    }
    const data = await res.json();

    // Por equipo (por ID, no por nombre), lista cronológica de resultados (G/E/P) —
    // nos quedamos con los últimos 3.
    const porEquipo: Record<number, { fecha: string; r: string }[]> = {};
    for (const m of (data.matches || [])) {
      const hs = m.score?.fullTime?.home, as = m.score?.fullTime?.away;
      if (hs == null || as == null) continue;
      const fecha = m.utcDate || '';
      const homeId = m.homeTeam?.id, awayId = m.awayTeam?.id;
      const rHome = hs > as ? 'G' : hs === as ? 'E' : 'P';
      const rAway = as > hs ? 'G' : hs === as ? 'E' : 'P';
      if (homeId != null) (porEquipo[homeId] ||= []).push({ fecha, r: rHome });
      if (awayId != null) (porEquipo[awayId] ||= []).push({ fecha, r: rAway });
    }
    for (const [id, resultados] of Object.entries(porEquipo)) {
      resultados.sort((a, b) => a.fecha.localeCompare(b.fecha));
      map.set(Number(id), resultados.slice(-3).map(x => x.r));
    }
  } catch (e) {
    console.error(`Error fetching forma (${competition}):`, e);
  }
  return map;
}

// Tabla de clasificación completa desde football-data.org (posición, puntos, PJ, racha) —
// null si la petición falla, para poder caer de vuelta a ESPN (sin racha) en ese caso.
async function getEquiposFromFBD(competition: string): Promise<EquipoClasi[] | null> {
  try {
    const [tablaRes, formaMap] = await Promise.all([
      fetch(`https://api.football-data.org/v4/competitions/${competition}/standings`, {
        headers: { "X-Auth-Token": FBDATA_KEY },
      }),
      getFormaFromFBD(competition),
    ]);
    if (!tablaRes.ok) {
      console.error(`football-data.org standings error (${competition}):`, tablaRes.status);
      return null;
    }
    const data = await tablaRes.json();
    const grupo = (data.standings || []).find((g: any) => g.type === 'TOTAL') || data.standings?.[0];
    const tabla = grupo?.table || [];
    if (tabla.length === 0) return null;
    return tabla.map((row: any) => ({
      pos: row.position,
      name: row.team?.shortName || row.team?.name || '',
      pts: row.points,
      pj: row.playedGames,
      forma: formaMap.get(row.team?.id) || [],
    }));
  } catch (e) {
    console.error(`Error fetching tabla (${competition}):`, e);
    return null;
  }
}

// ============ PRIMERA DIVISIÓN — jornada válida ============
const DIAS_FINDE = new Set(["VIE", "SAB", "DOM", "LUN"]);

function normalizeTeam(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // quitar acentos
    .replace(/\b(cf|fc|cd|ca|rc|rcd|ud|sd|club|de|balompie|futbol|deportivo|real)\b/g, " ")
    .replace(/[^a-z0-9]/g, "");
}

let _primeraCache: { names: string[]; fetchedAt: number } | null = null;

async function getPrimeraDivisionNames(): Promise<string[]> {
  const now = Date.now();
  if (_primeraCache && (now - _primeraCache.fetchedAt) < 6 * 60 * 60 * 1000) {
    return _primeraCache.names;
  }
  try {
    const res = await fetch("https://api.football-data.org/v4/competitions/PD/teams", {
      headers: { "X-Auth-Token": FBDATA_KEY },
    });
    if (!res.ok) return _primeraCache?.names || [];
    const data = await res.json();
    const names: string[] = [];
    for (const t of (data.teams || [])) {
      if (t.name) names.push(normalizeTeam(t.name));
      if (t.shortName) names.push(normalizeTeam(t.shortName));
      if (t.tla) names.push(normalizeTeam(t.tla));
    }
    _primeraCache = { names: names.filter(Boolean), fetchedAt: now };
    return _primeraCache.names;
  } catch (e) {
    console.error("Error fetching Primera teams:", e);
    return _primeraCache?.names || [];
  }
}

function esEquipoPrimera(teamName: string, primeraNames: string[]): boolean {
  const n = normalizeTeam(teamName);
  if (!n) return false;
  return primeraNames.some((p) => p && (n.includes(p) || p.includes(n)));
}

// Las casillas 1-8 del boleto (y el Pleno al 15) casi siempre enfrentan a DOS equipos de Primera
// — no basta con que participe alguno, como exige el resto de casillas (9-14, que mezclan con
// Segunda). Es una señal mucho más fiable: una jornada de Selecciones/Copa podría colar algún
// equipo suelto reconocido, pero que 1-8 sean Primera-contra-Primera de verdad es mucho más
// difícil de simular por casualidad.
function esPartidoPrimeraVsPrimera(p: any, primeraNames: string[]): boolean {
  return esEquipoPrimera(p.l, primeraNames) && esEquipoPrimera(p.v, primeraNames);
}

// Validación real activada: temporada 26/27 en marcha.
const SALTAR_VALIDACION_TEMPORAL = false;

async function evaluarJornadaValida(partidos: any[]): Promise<{ valida: boolean; primeraCount: number }> {
  const primeraNames = await getPrimeraDivisionNames();
  const regulares = partidos.filter((p: any) => p.posicion <= 14);
  let primeraCount = 0;
  for (const p of regulares) {
    if (esEquipoPrimera(p.l, primeraNames) || esEquipoPrimera(p.v, primeraNames)) primeraCount++;
  }

  // 1-8 + Pleno al 15: exige Primera-contra-Primera en la mayoría (se deja algo de margen, no
  // las 9 de 9, por si algún fin de semana raro reordena alguna casilla) — si no hay suficientes,
  // probablemente ni es Primera de verdad.
  const primerasOcho = partidos.filter((p: any) => p.posicion >= 1 && p.posicion <= 8);
  const pleno = partidos.find((p: any) => p.posicion === 15 || p.pleno);
  const candidatasPrimeraVsPrimera = pleno ? [...primerasOcho, pleno] : primerasOcho;
  const ambosPrimeraCount = candidatasPrimeraVsPrimera.filter((p: any) => esPartidoPrimeraVsPrimera(p, primeraNames)).length;
  const UMBRAL_1A8 = Math.max(0, candidatasPrimeraVsPrimera.length - 2); // margen de 2 casillas raras
  const pinta1a8DePrimera = candidatasPrimeraVsPrimera.length === 0 || ambosPrimeraCount >= UMBRAL_1A8;

  const diasConocidos = regulares.map((p: any) => p.dia).filter(Boolean);
  // Solo se rechaza por día si TODOS los partidos con día conocido caen fuera del finde (ej. jornada especial entre semana)
  const esFinDeSemana = diasConocidos.length === 0 || diasConocidos.some((d: string) => DIAS_FINDE.has(d));
  if (SALTAR_VALIDACION_TEMPORAL) return { valida: true, primeraCount };
  // Antes también se exigía primeraCount >= 5 sobre las 14 casillas regulares (bastaba con que
  // apareciera UN equipo de Primera en cada una) — se quitó por redundante y menos preciso:
  // pinta1a8DePrimera ya exige que en 1-8+Pleno los DOS equipos sean de Primera en casi todas, una
  // señal mucho más difícil de colar por casualidad en una jornada de Copa/Champions/Selecciones.
  // primeraCount se sigue calculando y devolviendo solo para mostrarlo en el aviso de la previa.
  return { valida: esFinDeSemana && pinta1a8DePrimera, primeraCount };
}

// ============ SERVE ============
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const tipo = body.tipo;
    const jornadaHistorica = body.jornadaHistorica;

    // Historical jornada — Eduardo Losilla only (official results)
    if (jornadaHistorica) {
      const parsed = await fetchEscrutinio(jornadaHistorica);
      // Si Losilla todavía no ha publicado esta jornada, su web puede devolver (o redirigir a)
      // otra jornada en vez de un error — sin estos dos chequeos, esa otra jornada se mostraría
      // mal etiquetada como si fuera la solicitada. El número por sí solo NO basta: Losilla
      // reutiliza números de jornada entre temporadas (ej. una ronda de Copa del Rey ya jugada
      // hace meses, de la temporada 25/26, resultó llevar el mismo "JORNADA 25" que todavía no
      // existe para la 26/27) — así que además de que el número coincida, se exige que la
      // temporada de esa página sea la actual; si no, se trata igual que "aún no publicada".
      if (parsed.jornadaNum === jornadaHistorica && parsed.temporada === temporadaEsperada() && parsed.partidos.length >= 13) {
        // `dia` (VIE/SAB/DOM/LUN...) lo usa cron-resultados para saber cuándo es de verdad el
        // último día de calendario de la jornada, y también sirve para la previa de Felix. El
        // campo `time__day` de Losilla ha dejado de traerlo (viene null para todos los partidos,
        // no solo el Pleno), así que día y hora se sacan los dos de football-data/ESPN por nombre
        // de equipo — Losilla queda solo como reserva si por lo que sea esa fuente tampoco lo trae.
        const horarios = await getPartidosConHorario();
        const horarioDe = (l: string, v: string) => findLiveScore(horarios, l, v);
        const regular = regularByPosicion(parsed.partidos, (p: any) => {
          const h = horarioDe(p.l, p.v);
          // Losilla dice "finalizado" solo porque el hueco de la hora está oculto en su HTML —
          // y eso también pasa en un partido APLAZADO (sin hora que mostrar), con un marcador
          // "0-0" de relleno que parece un empate real (caso Rayo-Ath.Club, jornada 12). Si
          // football-data/ESPN conoce este partido y dice explícitamente que no ha terminado, eso
          // manda sobre la suposición de Losilla.
          const aplazado = p.c && postergadoSegunFuente(h);
          const cerrado = p.c && !aplazado;
          // suspendido viaja aparte de "c" para que la app pueda distinguir "nadie ha apostado
          // aquí todavía" (neutro) de "este partido empezó y se ha quedado a medias" (aviso real,
          // distinto color) — sin esto el cliente no tiene forma de saber POR QUÉ sigue sin cerrar.
          return { l: p.l, v: p.v, r: cerrado ? (p.r || null) : null, c: cerrado, marcador: cerrado ? (p.marcador || null) : null, suspendido: !!aplazado, dia: p.dia || h?.dia || null, hora: h?.hora || null };
        });
        const pleno = parsed.partidos.find((p: any) => p.posicion === 15 || p.pleno);
        const hPleno = pleno ? horarioDe(pleno.l, pleno.v) : undefined;
        const plenoAplazado = pleno?.c && postergadoSegunFuente(hPleno);
        const plenoCerrado = !!pleno?.c && !plenoAplazado;
        regular.push({ l: pleno?.l || "Pleno al 15", v: pleno?.v || "", r: null, c: plenoCerrado, pleno: true, marcador: plenoCerrado ? (pleno?.marcador || null) : null, suspendido: !!plenoAplazado, dia: pleno?.dia || hPleno?.dia || null, hora: hPleno?.hora || null });
        // Mismo chequeo de "¿esto es de verdad una jornada de Primera?" que ya usa la pantalla
        // en vivo — aquí NO bloquea (Felix necesita poder ver los partidos igual para decidir),
        // solo viaja como dato para que quien la reciba avise si hace falta.
        const { valida: jornadaValida, primeraCount } = await evaluarJornadaValida(parsed.partidos);
        return new Response(JSON.stringify({ jornadaNum: jornadaHistorica, temporada: parsed.temporada, source: "eduardolosilla_historico", jornadaValida, primeraCount, partidos: regular }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // El escrutinio de esta jornada (futura) aún no existe para la temporada actual — pasa
      // sobre todo justo después de saltar una jornada de Champions/Copa, cuando se pregunta por
      // la siguiente antes de que Losilla publique su escrutinio. Antes de rendirse, se prueba la
      // página de "Próximas" (ver fetchProximas): siempre enseña la jornada inmediatamente
      // siguiente a la que ya está en juego, sin el problema de reutilización de números entre
      // temporadas que tiene el escrutinio. Solo se acepta si su propio número coincide
      // exactamente con el pedido — si no, puede que lo que haga falta sea más de una jornada por
      // delante (esta página solo conoce la siguiente inmediata), y se trata igual que "todavía
      // no publicada".
      const proximas = await fetchProximas();
      if (proximas.jornadaNum === jornadaHistorica && proximas.partidos.length >= 13) {
        const { regular, jornadaValida, primeraCount } = await construirDesdeProximas(proximas);
        return new Response(JSON.stringify({ jornadaNum: jornadaHistorica, temporada: temporadaEsperada(), source: "eduardolosilla_proximas", jornadaValida, primeraCount, partidos: regular }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ error: "No se pudo obtener la jornada histórica" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 404 });
    }

    // LaLiga Primera/Segunda/Liga F
    if (tipo === "liga1" || tipo === "liga2" || tipo === "ligaf") {
      const fbdCompetition = FBD_COMPETITION_POR_TIPO[tipo];

      // Primera/Segunda: football-data.org da tabla + racha ya cruzadas por ID, sin ambigüedad.
      if (fbdCompetition) {
        const equiposFbd = await getEquiposFromFBD(fbdCompetition);
        if (equiposFbd) {
          return new Response(JSON.stringify({ tipo, source: "football-data", equipos: equiposFbd }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        console.error(`football-data.org falló para ${tipo}, usando ESPN sin racha como reserva`);
      }

      // Liga F, o reserva si football-data.org falla: ESPN, sin racha (no la tenemos de forma fiable)
      const league = tipo === "liga1" ? "esp.1" : tipo === "liga2" ? "esp.2" : "esp.w.1";
      const data = await getESPNStandings(league);
      const entries = data.standings?.entries || data.children?.[0]?.standings?.entries || [];
      const equipos = entries
        .sort((a: any, b: any) => getStat(a.stats, 'rank') - getStat(b.stats, 'rank'))
        .map((e: any) => ({
          pos: getStat(e.stats, 'rank'),
          name: (e.team?.shortDisplayName || e.team?.displayName || "").trim(),
          pts: getStat(e.stats, 'points'),
          pj: getStat(e.stats, 'gamesPlayed'),
          forma: [],
        }));
      return new Response(JSON.stringify({ tipo, source: "espn", equipos }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // DEFAULT: partidos jornada activa
    // 1. Get team names and official results from Eduardo Losilla
    const jornadaActual = await getJornadaActual();
    const parsed = await fetchEscrutinio(jornadaActual);

    // Mismo guard de temporada que ya usa la rama jornadaHistorica: no basta con que el número de
    // jornada coincida y haya ≥13 partidos — Losilla reutiliza números de jornada entre temporadas
    // (caso real: "JORNADA 25" devolvía una ronda de Copa del Rey ya jugada de la temporada 25/26,
    // en vez de la jornada 25 de la 26/27 que todavía no estaba publicada). Sin este chequeo, esa
    // página vieja se aceptaba como buena, se evaluaba jornadaValida con los equipos equivocados
    // (salía false), y el jugador normal veía "no hay jornada de Primera" aunque el admin ya
    // hubiera confirmado la jornada real a través de /proximas.
    const escrutinioPublicado = parsed.jornadaNum === jornadaActual && parsed.temporada === temporadaEsperada() && parsed.partidos.length >= 13;

    if (!escrutinioPublicado) {
      // Escrutinio todavía no publicado para esta jornada — pasa justo al abrirla, si Losilla aún
      // no ha sacado su escrutinio aunque ya tenga el boleto listo en /proximas (mismo caso que
      // ya resuelve la rama jornadaHistorica de arriba, ver fetchProximas/construirDesdeProximas).
      // Sin este fallback, la vista normal del jugador se quedaba mostrando "no hay jornada de
      // Primera" aunque la previa del admin ya la hubiera detectado bien.
      const proximas = await fetchProximas();
      if (proximas.jornadaNum === jornadaActual && proximas.partidos.length >= 13) {
        const { regular, jornadaValida, primeraCount } = await construirDesdeProximas(proximas);
        if (!jornadaValida) {
          return new Response(JSON.stringify({
            jornadaValida: false, jornadaNum: jornadaActual, temporada: temporadaEsperada(), temporadaEsperada: temporadaEsperada(), primeraCount, partidos: [],
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ jornadaValida: true, jornadaNum: jornadaActual, temporada: temporadaEsperada(), temporadaEsperada: temporadaEsperada(), source: "eduardolosilla_proximas", partidos: regular }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "No se pudieron obtener los partidos", jornadaNum: jornadaActual }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 });
    }

    // 1b. Jornada válida: ver evaluarJornadaValida (1-8+Pleno Primera-contra-Primera + finde)
    const { valida: jornadaValida, primeraCount } = await evaluarJornadaValida(parsed.partidos);
    if (!jornadaValida) {
      return new Response(JSON.stringify({
        jornadaValida: false, jornadaNum: parsed.jornadaNum || jornadaActual, temporada: parsed.temporada, temporadaEsperada: temporadaEsperada(), primeraCount, partidos: [],
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 2. Get live scores (y de paso, hora de cada partido): football-data.org first, ESPN as fallback
    const liveScores = await getPartidosConHorario();

    // `dia` de Losilla ha dejado de venir (null para todos los partidos) — se completa con el
    // día que trae football-data/ESPN, dejando Losilla como preferido por si algún día vuelve.
    const regular = regularByPosicion(parsed.partidos, (p: any) => {
      const live = findLiveScore(liveScores, p.l, p.v);
      const hora = live?.hora || null;
      const dia = p.dia || live?.dia || null;
      // If already closed in Losilla, use that — PERO solo si la fuente en vivo no lo contradice
      // explícitamente (aplazado/suspendido en vez de jugado de verdad; ver postergadoSegunFuente).
      if (p.c && p.r) {
        if (postergadoSegunFuente(live)) {
          return { l: p.l, v: p.v, r: null, c: false, marcador: null, suspendido: true, dia, hora };
        }
        return { l: p.l, v: p.v, r: p.r, c: true, marcador: p.marcador, dia, hora };
      }
      // Otherwise check live score
      if (live && live.marcador) {
        return { l: p.l, v: p.v, r: live.r, c: live.c, marcador: live.marcador, dia, hora };
      }
      return { l: p.l, v: p.v, r: null, c: false, marcador: null, dia, hora };
    });

    const pleno = parsed.partidos.find((p: any) => p.posicion === 15 || p.pleno);
    const plenoLive = pleno ? findLiveScore(liveScores, pleno.l, pleno.v) : undefined;
    const plenoAplazado = pleno?.c && postergadoSegunFuente(plenoLive);
    const plenoCerradoDefault = !!pleno?.c && !plenoAplazado;
    regular.push({ l: pleno?.l || "Pleno al 15", v: pleno?.v || "", r: null, c: plenoCerradoDefault, pleno: true, marcador: plenoCerradoDefault ? (pleno?.marcador || null) : null, suspendido: !!plenoAplazado, dia: pleno?.dia || plenoLive?.dia || null, hora: plenoLive?.hora || null });

    return new Response(JSON.stringify({ jornadaValida: true, jornadaNum: parsed.jornadaNum || jornadaActual, temporada: parsed.temporada, temporadaEsperada: temporadaEsperada(), source: "losilla+espn", partidos: regular }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 });
  }
});
