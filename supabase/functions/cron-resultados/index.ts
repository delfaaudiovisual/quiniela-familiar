import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const SUPA_FUNCTIONS_URL = Deno.env.get("SUPABASE_URL")!.replace('.supabase.co', '.supabase.co/functions/v1');
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const JUGADORES = ['deborah','alexander','virginia','ivan','jonathan','daniel','nines','felix','mari','javier'];
// TEMPORAL: 'daniel' añadido para no depender solo de Felix mientras se resuelve el bug de hoy —
// quitarlo cuando esté solucionado (coincide con ADMINS en index.html y quick-task).
const ADMINS = ['felix', 'daniel'];
// 15 posiciones: 10 individuales + 5 parejas (p1..p5) — coincide con ORDEN0 de index.html
const ORDEN0 = ['javier','mari','felix','nines','daniel','jonathan','ivan','virginia','alexander','deborah','p1','p2','p3','p4','p5'];
const PAREJAS: Record<string, {id:string, jugadores:[string,string]}> = {
  p1: {id:'p1', jugadores:['mari','javier']},
  p2: {id:'p2', jugadores:['nines','felix']},
  p3: {id:'p3', jugadores:['jonathan','daniel']},
  p4: {id:'p4', jugadores:['virginia','alexander']},
  p5: {id:'p5', jugadores:['deborah','ivan']},
};
const JUGADOR_PAREJA: Record<string,string> = {
  javier:'p1', mari:'p1', felix:'p2', nines:'p2', jonathan:'p3', daniel:'p3',
  virginia:'p4', alexander:'p4', deborah:'p5', ivan:'p5',
};
const NOMBRES: Record<string,string> = {
  deborah:'Deborah', alexander:'Alexander', virginia:'Virginia', ivan:'Ivan',
  jonathan:'Jonathan', daniel:'Daniel', nines:'Nines', felix:'Felix',
  mari:'Mari', javier:'Javier'
};

function getOrden(rotacion: number): string[] {
  const n = ORDEN0.length; // 15
  const offset = (rotacion - 1) % n;
  return [...ORDEN0.slice(offset), ...ORDEN0.slice(0, offset)];
}

// Traduce un número de jornada de LaLiga a la "ronda real" de la familia — solo avanza cuando
// una jornada se juega de verdad (ver mismo concepto en index.html/getRotacion). Sin fila
// explícita, se asume que coincide con el propio número de jornada.
async function getRotacion(jornada: number): Promise<number> {
  // .limit(1) en vez de .maybeSingle() — si por lo que sea llegara a haber más de una fila,
  // no revienta, simplemente coge una en vez de fallar (igual de bien que .maybeSingle() en el
  // caso normal de una sola fila, pero sin el riesgo de reventar como pasó con jornada_actual).
  const { data } = await supabase
    .from('jornada_estado')
    .select('valor')
    .eq('jornada', jornada)
    .eq('clave', 'rotacion')
    .limit(1);
  const r = data?.[0]?.valor ? parseInt(data[0].valor) : null;
  return r != null && !isNaN(r) ? r : jornada;
}

function getPos(id: string, rotacion: number): number {
  const orden = getOrden(rotacion);
  return orden.indexOf(id) + 1;
}

function getParejaId(jugadorId: string): string {
  return JUGADOR_PAREJA[jugadorId] || '';
}

function signoFromMarcador(marcador: string | null): string | null {
  if (!marcador) return null;
  const [gl, gv] = marcador.replace(' 🔴', '').split('-').map((x: string) => parseInt(x));
  if (isNaN(gl) || isNaN(gv)) return null;
  return gl > gv ? '1' : gl === gv ? 'X' : '2';
}

// El Pleno al 15 se apuesta en "cubos" de goles: 0, 1, 2 o M (3 o más) — no el gol exacto.
function golesABucket(n: string | number): string | null {
  const num = typeof n === 'number' ? n : parseInt(n);
  if (isNaN(num)) return null;
  return num >= 3 ? 'M' : String(num);
}
function valorBucket(bucket: string): number {
  return bucket === 'M' ? 3 : parseInt(bucket);
}

// Puntos del Pleno al 15 — individual: +1 signo, +1.5 extra si marcador exacto (2.5). Pareja: +0.5/+0.5 (1).
function puntosPleno(pt: any, apostado: { l: string; v: string } | undefined, esPareja: boolean): number {
  if (!pt || !pt.c || !pt.marcador || !apostado || !apostado.l || !apostado.v) return 0;
  const [gl, gv] = pt.marcador.replace(' 🔴', '').split('-');
  if (gl === undefined || gv === undefined) return 0;
  const signoReal = signoFromMarcador(pt.marcador);
  const vl = valorBucket(apostado.l), vv = valorBucket(apostado.v);
  if (!signoReal || isNaN(vl) || isNaN(vv)) return 0;
  const signoApostado = vl > vv ? '1' : vl === vv ? 'X' : '2';
  if (signoApostado !== signoReal) return 0;
  const exacto = apostado.l === golesABucket(gl) && apostado.v === golesABucket(gv);
  const base = esPareja ? 0.5 : 1;
  const extra = esPareja ? 0.5 : 1.5;
  return exacto ? base + extra : base;
}

function signo(r: string | null): string {
  return r || '?';
}

async function callNotifications(payload: object) {
  try {
    const url = `${SUPA_FUNCTIONS_URL}/quick-task`;
    console.log('Calling notifications:', url, JSON.stringify(payload));
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    console.log('Notifications response:', res.status, text);
  } catch(e) {
    console.error('Error calling notifications:', e);
  }
}

async function getPartidos(jornada: number): Promise<{ partidos: any[]; temporada: string | null; jornadaValida: boolean | null }> {
  try {
    const res = await fetch(`${SUPA_FUNCTIONS_URL}/quiniela-jornada`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ jornadaHistorica: jornada })
    });
    const data = await res.json();
    // jornadaValida (misma comprobación que la pantalla normal: suficientes equipos de Primera +
    // días de fin de semana) — null si la respuesta no trae el campo, para distinguir "no sabemos
    // todavía" de "sabemos que NO es válida" en quien llama.
    return { partidos: data.partidos || [], temporada: data.temporada || null, jornadaValida: data.jornadaValida ?? null };
  } catch(e) {
    console.error('Error getting partidos:', e);
    return { partidos: [], temporada: null, jornadaValida: null };
  }
}

// Misma lógica que en quiniela-jornada: temporada esperada ahora mismo, ej. "26/27"
function temporadaEsperada(): string {
  const now = new Date();
  const mes = now.getMonth() + 1;
  const inicio = mes >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  const dosDigitos = (y: number) => String(y % 100).padStart(2, '0');
  return `${dosDigitos(inicio)}/${dosDigitos(inicio + 1)}`;
}

// Orden semanal para saber si ya llegamos al último día de calendario de una jornada, sin fecha
// fija en el código: empieza el jueves (cuando se abren las apuestas) y da la vuelta completa, así
// una jornada normal viernes-lunes y una rara entre semana (tras congestión de calendario, con
// partidos en día laborable) se comparan con el mismo criterio, usando el día real que trae cada
// partido desde Eduardo Losilla (campo `dia`).
const ORDEN_DIAS: Record<string, number> = { JUE: 0, VIE: 1, SAB: 2, DOM: 3, LUN: 4, MAR: 5, MIE: 6 };
const DIA_JS = ['DOM', 'LUN', 'MAR', 'MIE', 'JUE', 'VIE', 'SAB']; // índice = Date.getDay()

function yaLlegoUltimoDiaJornada(partidos: any[]): boolean {
  // Incluye el Pleno al 15 — es un partido real como cualquiera de los otros 14 (a veces el que
  // se juega más tarde) y su día debe contar igual a la hora de saber cuál es el último.
  const dias = partidos
    .filter(p => p.dia)
    .map(p => ORDEN_DIAS[p.dia])
    .filter(d => d !== undefined);
  if (dias.length === 0) return true; // sin dato de día para ningún partido — no bloqueamos por esto
  const ultimoDiaJornada = Math.max(...dias);
  const ordenHoy = ORDEN_DIAS[DIA_JS[new Date().getDay()]];
  return ordenHoy >= ultimoDiaJornada;
}

// El Pleno al 15 no tiene `r` (no se apuesta a signo, sino a tramos de goles) — su único
// indicador de "terminado" es `c`. Los otros 14 necesitan además el signo (`r`).
function partidoTerminado(p: any): boolean {
  return p.pleno ? !!p.c : !!(p.c && p.r);
}

// La tabla `apuestas_pleno` no tiene columna `apostado_por` — "apostar por otro" en el Pleno
// (index.html/apostarPlenoPorOtro) guarda esa marca como una fila más en la tabla `apuestas`,
// con un jugador_id sintético '_pleno_por_<entityId>'. Aquí se traduce de vuelta directamente a
// apostadoPor[entityId] (el mismo mapa que ya usan las casillas normales), en vez de dejarla
// como una entrada suelta con la clave rara.
function procesarFilaApuesta(a: any, apuestas: Record<string, string>, apostadoPor: Record<string, string>) {
  if (typeof a.jugador_id === 'string' && a.jugador_id.startsWith('_pleno_por_')) {
    if (a.apostado_por) apostadoPor[a.jugador_id.slice('_pleno_por_'.length)] = a.apostado_por;
    return;
  }
  apuestas[a.jugador_id] = a.apuesta;
  if (a.apostado_por) apostadoPor[a.jugador_id] = a.apostado_por;
}

// Puntos de una jornada para cada jugador — extraído aparte porque se usa dos veces: para "esta
// jornada" en el aviso de cierre, y para acumular la clasificación general jornada a jornada.
function calcularPuntosJornada(
  rotacion: number,
  partidos: any[],
  apuestas: Record<string, string>,
  apostadoPor: Record<string, string>,
  plenoApuestas: Record<string, { l: string; v: string }>,
  dobleData: { jugador_id: string; casilla: number; apuesta: string } | null
): Record<string, number> {
  const puntos: Record<string, number> = {};
  for (const jugadorId of JUGADORES) {
    let pts = 0;
    const posInd = getPos(jugadorId, rotacion);
    const ptInd = partidos[posInd - 1];
    if (ptInd) {
      if (ptInd.pleno) {
        if (!apostadoPor[jugadorId]) pts += puntosPleno(ptInd, plenoApuestas[jugadorId], false);
      } else if (ptInd.c && ptInd.r && apuestas[jugadorId] && !apostadoPor[jugadorId]) {
        if (apuestas[jugadorId] === ptInd.r) pts += 1;
      }
    }

    const parejaId = getParejaId(jugadorId);
    const posPar = getPos(parejaId, rotacion);
    const ptPar = posPar > 0 ? partidos[posPar - 1] : null;
    if (ptPar) {
      if (ptPar.pleno) {
        if (!apostadoPor[parejaId]) pts += puntosPleno(ptPar, plenoApuestas[parejaId], true);
      } else if (ptPar.c && ptPar.r && apuestas[parejaId] && !apostadoPor[parejaId]) {
        if (apuestas[parejaId] === ptPar.r) pts += 0.5;
      }
    }

    puntos[jugadorId] = pts;
  }

  if (dobleData && dobleData.casilla >= 1 && dobleData.casilla <= 14) {
    const ptDoble = partidos[dobleData.casilla - 1];
    if (ptDoble && ptDoble.c && ptDoble.r) {
      const acierta = dobleData.apuesta === ptDoble.r;
      if (puntos[dobleData.jugador_id] !== undefined) {
        puntos[dobleData.jugador_id] += acierta ? 1 : -0.5;
      }
    }
  }

  return puntos;
}

// Clasificación GENERAL acumulada hasta (e incluyendo) una jornada — misma cuenta que hace el
// frontend en calcPuntos()/renderRanking(), jornada a jornada. Se usa para el aviso de cierre:
// la posición que se comunica es la de la general, no la de esa única jornada.
async function calcularClasificacionGeneral(hastaJornada: number): Promise<{ id: string; nombre: string; pts: number }[]> {
  const acumulado: Record<string, number> = {};
  JUGADORES.forEach(j => { acumulado[j] = 0; });

  for (let j = 1; j <= hastaJornada; j++) {
    const { partidos: partidosJ } = await getPartidos(j);
    if (partidosJ.length === 0) continue;
    const rotacionJ = await getRotacion(j);

    const { data: apuestasData } = await supabase.from('apuestas').select('jugador_id,apuesta,apostado_por').eq('jornada', j);
    const apuestasJ: Record<string, string> = {};
    const apostadoPorJ: Record<string, string> = {};
    (apuestasData || []).forEach((a: any) => procesarFilaApuesta(a, apuestasJ, apostadoPorJ));

    const { data: plenoData } = await supabase.from('apuestas_pleno').select('pareja_id,goles_local,goles_visitante').eq('jornada', j);
    const plenoApuestasJ: Record<string, { l: string; v: string }> = {};
    (plenoData || []).forEach((r: any) => { plenoApuestasJ[r.pareja_id] = { l: r.goles_local, v: r.goles_visitante }; });

    const { data: dobleData } = await supabase.from('apuestas_doble').select('jugador_id,casilla,apuesta').eq('jornada', j).maybeSingle();

    const puntosJ = calcularPuntosJornada(rotacionJ, partidosJ, apuestasJ, apostadoPorJ, plenoApuestasJ, dobleData);
    JUGADORES.forEach(jug => { acumulado[jug] += (puntosJ[jug] || 0); });
  }

  return JUGADORES
    .map(j => ({ id: j, nombre: NOMBRES[j], pts: acumulado[j] }))
    .sort((a, b) => b.pts - a.pts);
}

// Cuántas jornadas seguidas de Champions/Copa/Selecciones se admite auto-saltar en una sola
// pasada del cron antes de parar — en la práctica nunca debería hacer falta más de una o dos,
// esto es solo un límite de seguridad para no quedarse en un bucle si algo raro pasara con los
// datos.
const MAX_AUTOSALTOS_POR_PASE = 10;

// Quién recibe el aviso silencioso de cada auto-salto (no requiere respuesta) — distinto de
// ADMINS (quien recibe la pregunta de confirmación de verdad): solo Daniel, para que a Felix
// nunca le llegue ruido de las jornadas de Champions/Copa que se saltan solas — a él solo le
// llegan las jornadas de Primera que de verdad le toca confirmar.
const ADMINS_AVISO_SILENCIOSO = ['daniel'];

// Mira la jornada siguiente a `jornadaCierre` y, mientras no sea de Primera (jornadaValida
// false) pero ya tenga datos publicados, la salta ella sola — sin esperar a que nadie pulse nada
// — y sigue mirando la de después, encadenado (ej. dos jornadas de Champions seguidas se saltan
// las dos solas en el mismo pase). En cuanto encuentra una jornada que SÍ es de Primera, o se
// queda sin datos todavía publicados de la siguiente, para ahí: si es de Primera, deja la
// confirmación pendiente para que a los admins solo les quede confirmar que la jugamos (el
// sistema ya ha comprobado que son partidos de Primera); si no hay datos aún, no hace nada más y
// lo reintenta en el siguiente pase del cron — como cada auto-salto ya queda guardado en el
// momento en que ocurre, nunca se vuelve a mirar ni se repite una jornada ya saltada.
async function avanzarYPreguntarSiguiente(jornadaCierreInicial: number, rotacionInicial: number) {
  let jornadaCierre = jornadaCierreInicial;
  const rotacionCierre = rotacionInicial;

  for (let i = 0; i < MAX_AUTOSALTOS_POR_PASE; i++) {
    const candidato = jornadaCierre + 1;
    const { partidos: partidosCandidato, jornadaValida: validaCandidato } = await getPartidos(candidato);
    if (partidosCandidato.length < 13) {
      return; // todavía no hay datos publicados de esta jornada — se reintenta en el próximo pase
    }

    if (validaCandidato === false) {
      // No es de Primera (Champions/Copa/Selecciones u otra competición) — se salta sola. La
      // rotación se copia igual que haría un salto manual (no consume turno de nadie), y
      // jornada_actual avanza para que el cron siga vigilando desde aquí en el próximo pase.
      await supabase.from('jornada_estado').upsert({
        jornada: candidato, clave: 'rotacion', valor: String(rotacionCierre)
      }, { onConflict: 'jornada,clave' });
      await supabase.from('jornada_estado').upsert({
        jornada: candidato, clave: 'saltada', valor: 'true'
      }, { onConflict: 'jornada,clave' });
      await supabase.from('jornada_estado').upsert({
        jornada: candidato, clave: 'jornada_actual', valor: String(candidato)
      }, { onConflict: 'jornada,clave' });

      // Aviso silencioso solo a ADMINS_AVISO_SILENCIOSO (no requiere respuesta) — por si el
      // heurístico se equivocara alguna vez, que quede constancia de que algo se saltó solo.
      await callNotifications({
        tipo: 'aviso_admin',
        datos: {
          titulo: 'ℹ️ La Piripiniela',
          mensaje: `Jornada ${candidato} saltada automáticamente — no es de Primera (Champions/Copa/Selecciones u otra competición).`,
          destinatarios: ADMINS_AVISO_SILENCIOSO
        }
      });

      jornadaCierre = candidato;
      continue;
    }

    // validaCandidato === true: aquí para la cadena — ya hay una jornada de Primera real
    // esperando. jornada_cerrada_at evita repetir la pregunta en cada pase mientras nadie
    // responda.
    const cierreKey = 'jornada_cerrada_at';
    const { data: cierreData } = await supabase
      .from('jornada_estado')
      .select('valor')
      .eq('jornada', jornadaCierre)
      .eq('clave', cierreKey)
      .single();

    if (!cierreData) {
      const now = Date.now();
      await supabase.from('jornada_estado').upsert({
        jornada: jornadaCierre, clave: cierreKey, valor: String(now)
      });
      await supabase.from('jornada_estado').upsert({
        jornada: jornadaCierre, clave: 'pendiente_confirmacion', valor: 'true'
      });
      console.log('Jornada', jornadaCierre, 'cerrada a las', new Date(now).toISOString());

      // Sin mencionar ya la jornada anterior ("saltamos X") — con el auto-salto en cadena, esa
      // jornada anterior puede ser ella misma un salto automático del que nadie tuvo que
      // enterarse; lo único relevante para quien decide es que la nueva YA está confirmada como
      // de Primera.
      const mensajeConfirmacion = `🏁 Jornada ${candidato} ya disponible y parece de Primera. ¿Confirmas que abrimos apuestas? Pulsa para decidir.`;
      for (const admin of ADMINS) {
        await callNotifications({
          tipo: 'resultado_jornada',
          jugador_id: admin,
          datos: { mensaje: mensajeConfirmacion }
        });
      }
    }
    return;
  }
}

async function procesarJornada(jornada: number, esActual: boolean) {
    const notifsSent: string[] = [];
    const rotacion = await getRotacion(jornada);

    // 2. Get partidos for this jornada
    const { partidos, temporada, jornadaValida } = await getPartidos(jornada);
    if (partidos.length === 0) {
      return { ok: true, msg: 'No partidos', jornada };
    }
    // Solo se avanza de jornada automáticamente si Losilla ya tiene cargada la temporada esperada.
    // Evita que, mientras el sitio todavía sirve datos de la temporada anterior (ej. una jornada_actual=1
    // que en realidad es la 1 de la temporada pasada, ya cerrada), el cron avance jornada_actual solo.
    const temporadaOk = temporada === temporadaEsperada();

    // Aviso diferido de "jornada abierta" — quick-task (accion 'abrir') ya NO lo manda al
    // confirmar, solo deja marcado pendiente_notif_abierta='true'. Aquí, en cada pasada del cron,
    // se comprueba si esta jornada (la actual) ya tiene pinta de verdad de jornada normal de
    // Primera (jornadaValida) antes de avisar — así el "ya podéis apostar" llega justo cuando el
    // calendario real ya está publicado, ni antes (Losilla a medio publicar, con Selecciones de
    // relleno) ni con una espera fija que unas veces sobra y otras se queda corta.
    if (esActual) {
      const { data: pendienteAbierta } = await supabase
        .from('jornada_estado')
        .select('valor')
        .eq('jornada', jornada)
        .eq('clave', 'pendiente_notif_abierta')
        .maybeSingle();
      if (pendienteAbierta?.valor === 'true' && jornadaValida && temporadaOk) {
        await callNotifications({
          tipo: 'aviso_general',
          datos: { titulo: '🎉 La Piripiniela', mensaje: `Jornada ${jornada} abierta — ¡ya podéis apostar!` }
        });
        await supabase.from('jornada_estado').upsert({
          jornada, clave: 'pendiente_notif_abierta', valor: 'false'
        }, { onConflict: 'jornada,clave' });
        notifsSent.push('jornada_abierta');
      }
    }

    // 3. Get apuestas for this jornada
    const { data: apuestasData } = await supabase
      .from('apuestas')
      .select('jugador_id,apuesta,apostado_por')
      .eq('jornada', jornada);

    const apuestas: Record<string,string> = {};
    const apostadoPor: Record<string,string> = {};
    (apuestasData || []).forEach((a: any) => procesarFilaApuesta(a, apuestas, apostadoPor));

    const { data: plenoData } = await supabase
      .from('apuestas_pleno')
      .select('pareja_id,goles_local,goles_visitante')
      .eq('jornada', jornada);
    const plenoApuestas: Record<string, { l: string; v: string }> = {};
    (plenoData || []).forEach((r: any) => { plenoApuestas[r.pareja_id] = { l: r.goles_local, v: r.goles_visitante }; });

    const { data: dobleData } = await supabase
      .from('apuestas_doble')
      .select('jugador_id,casilla,apuesta')
      .eq('jornada', jornada)
      .maybeSingle();

    // 4. Get notificaciones ya enviadas (to avoid duplicates)
    const { data: notifState } = await supabase
      .from('jornada_estado')
      .select('clave,valor')
      .eq('jornada', jornada)
      .like('clave', 'notif_%');

    const notifEnviadas = new Set((notifState || []).map((n: any) => n.clave));

    // 5. For each jugador, check if their partido AND pareja partido have finished
    for (const jugadorId of JUGADORES) {
      const posInd = getPos(jugadorId, rotacion);
      const ptInd = partidos[posInd - 1];
      if (!ptInd || ptInd.pleno) continue;

      const apuestaInd = apuestas[jugadorId];
      if (!apuestaInd) continue; // didn't bet

      const parejaId = getParejaId(jugadorId);
      const posPar = getPos(parejaId, rotacion);
      const ptPar = posPar > 0 ? partidos[posPar - 1] : null;
      const apuestaPar = apuestas[parejaId];

      // Check individual partido
      const notifKeyInd = `notif_resultado_${jugadorId}`;
      if (!notifEnviadas.has(notifKeyInd) && ptInd.c && ptInd.r) {
        const acerto = apuestaInd === ptInd.r;
        const emoji = acerto ? '✅' : '❌';
        const msg = acerto
          ? `${emoji} Tu partido: ${ptInd.l} — ${ptInd.v} (${ptInd.marcador}) · ¡Acertaste el ${apuestaInd}!`
          : `${emoji} Tu partido: ${ptInd.l} — ${ptInd.v} (${ptInd.marcador}) · Era ${ptInd.r}, apostaste ${apuestaInd}`;

        await callNotifications({
          tipo: 'resultado_jornada',
          jugador_id: jugadorId,
          datos: { mensaje: msg }
        });

        await supabase.from('jornada_estado').upsert({ jornada, clave: notifKeyInd, valor: 'sent' });
        notifsSent.push(jugadorId + '_ind');
      }

      // Check pareja partido
      const notifKeyPar = `notif_resultado_${jugadorId}_pareja`;
      if (!notifEnviadas.has(notifKeyPar) && ptPar && !ptPar.pleno && ptPar.c && ptPar.r && apuestaPar) {
        const acertoPar = apuestaPar === ptPar.r;
        const emoji = acertoPar ? '✅' : '❌';
        const msg = acertoPar
          ? `${emoji} Pareja: ${ptPar.l} — ${ptPar.v} (${ptPar.marcador}) · ¡Acertasteis el ${apuestaPar}!`
          : `${emoji} Pareja: ${ptPar.l} — ${ptPar.v} (${ptPar.marcador}) · Era ${ptPar.r}, apostasteis ${apuestaPar}`;

        await callNotifications({
          tipo: 'resultado_jornada',
          jugador_id: jugadorId,
          datos: { mensaje: msg }
        });

        await supabase.from('jornada_estado').upsert({ jornada, clave: notifKeyPar, valor: 'sent' });
        notifsSent.push(jugadorId + '_par');
      }
    }

    // 5b. Notificación individual del resultado del Doble — separada de "tu partido", porque
    // el signo que ganó/perdió puede ser justo el contrario al que apostó el dueño de la casilla,
    // y mezclarlo con el resultado del dueño confunde a quien puso el doble.
    if (dobleData && dobleData.casilla >= 1 && dobleData.casilla <= 14) {
      const ptDoble = partidos[dobleData.casilla - 1];
      const notifKeyDoble = `notif_resultado_doble`;
      if (!notifEnviadas.has(notifKeyDoble) && ptDoble && !ptDoble.pleno && ptDoble.c && ptDoble.r) {
        const aciertaDoble = dobleData.apuesta === ptDoble.r;
        const duenoId = getOrden(rotacion)[dobleData.casilla - 1];
        const duenoPareja = PAREJAS[duenoId];
        const duenoNombre = duenoPareja ? duenoPareja.jugadores.map(j => NOMBRES[j]).join(' & ') : (NOMBRES[duenoId] || duenoId);
        const msgDoble = aciertaDoble
          ? `✅ Tu Doble: ${ptDoble.l} — ${ptDoble.v} (${ptDoble.marcador}) · ¡Acertaste el ${dobleData.apuesta}! +1 punto (casilla de ${duenoNombre})`
          : `❌ Tu Doble: ${ptDoble.l} — ${ptDoble.v} (${ptDoble.marcador}) · Era ${ptDoble.r}, apostaste ${dobleData.apuesta} · −0,5 puntos (casilla de ${duenoNombre})`;

        await callNotifications({
          tipo: 'resultado_jornada',
          jugador_id: dobleData.jugador_id,
          datos: { mensaje: msgDoble }
        });
        // El dueño de la casilla no recibe nada extra por el Doble (ni aviso ni puntos) —
        // su resultado ya le llega por la notificación normal de "tu partido"/"pareja".

        await supabase.from('jornada_estado').upsert({ jornada, clave: notifKeyDoble, valor: 'sent' });
        notifsSent.push('doble');
      }
    }

    // 6. Check if ALL partidos finished → send ranking notification + advance jornada
    const notifCierreKey = `notif_cierre_jornada`;
    // Estricto: exige TAMBIÉN los partidos suspendidos (y el Pleno al 15) — solo se cumple
    // cuando de verdad no queda nada pendiente, ni siquiera un aplazado. Gatea el cálculo de
    // puntos (más abajo), que debe esperar al resultado real por tarde que llegue, y el
    // marcador "todos_resueltos" que decide si el cron sigue revisando esta jornada en pasadas
    // futuras.
    const todosTerminados = partidos.every(partidoTerminado);
    // Suelto: ignora los partidos suspendidos, pero SÍ exige el Pleno al 15 (es un partido real,
    // a veces el último de la jornada) — la jornada "acaba" en cuanto se ha jugado todo lo que
    // seguía en calendario, sin esperar a un aplazado que puede tardar semanas en reprogramarse.
    // Gatea el aviso a Felix para abrir/saltar la siguiente y el resumen de jornada (con los
    // puntos ya conocidos; el de la casilla suspendida queda pendiente).
    const calendarioCompleto = partidos.filter(p => !p.suspendido).every(partidoTerminado);
    const haySuspendidoPendiente = partidos.some(p => p.suspendido);

    // Una jornada "saltada" no tiene apuestas que proteger — a diferencia de una jugada de
    // verdad, no hace falta esperar a que sus partidos reales (a menudo de Champions/selecciones,
    // con calendario propio y a veces solo un día de margen antes de la jornada de LaLiga
    // siguiente) terminen del todo. Ahí basta con que la SIGUIENTE jornada ya tenga datos
    // publicados en Eduardo Losilla para poder enseñarle a Felix una previa completa.
    const { data: saltadaRow } = await supabase
      .from('jornada_estado')
      .select('valor')
      .eq('jornada', jornada)
      .eq('clave', 'saltada')
      .limit(1);
    const esSaltada = saltadaRow?.[0]?.valor === 'true';

    // ¿Ya terminó lo que había que terminar de ESTA jornada? Si fue saltada no hay partidos
    // propios que esperar; si se jugó de verdad, hace falta que su propio calendario haya
    // acabado. Solo entonces tiene sentido mirar qué pasa con la siguiente.
    const listoParaMirarSiguiente = esSaltada || (calendarioCompleto && yaLlegoUltimoDiaJornada(partidos));

    // Toca mirar la siguiente jornada — solo tiene sentido al procesar la jornada realmente
    // actual, y solo cuando Losilla ya sirve la temporada esperada. Antes de preguntarle nada a
    // Felix, se auto-saltan en cadena todas las jornadas que no sean de Primera
    // (Champions/Copa/Selecciones), y solo se le pregunta por la primera que sí lo sea — ya
    // confirmada, así que a él solo le queda decir que sí. Sin escalado automático para esa
    // pregunta final: si Felix no contesta, no pasa nada solo — se queda esperando
    // indefinidamente a que él confirme desde la pantalla de admin.
    if (esActual && listoParaMirarSiguiente && temporadaOk) {
      await avanzarYPreguntarSiguiente(jornada, rotacion);
    }

    // Una jornada "saltada" (nadie apostó) nunca tiene filas en `apuestas` — sin este filtro,
    // calendarioCompleto igualmente se cumpliría (los partidos reales de LaLiga se juegan
    // igual) y mandaría un absurdo "Líder: alguien con 0pts" para una jornada que no se jugó.
    const hayApuestas = Object.keys(apuestas).length > 0;

    if (calendarioCompleto && hayApuestas && !notifEnviadas.has(notifCierreKey)) {
      // Puntos de ESTA jornada — la casilla de un partido suspendido simplemente no suma su
      // punto todavía (como cualquier partido sin jugar), sin penalizar a nadie; en cuanto ese
      // resultado llegue (aunque sea semanas después), calcPuntos() en el frontend ya lo
      // recalcula solo, y la notificación individual tardía (sección 5a/5b más arriba) avisa al
      // jugador afectado.
      const puntosJornada = calcularPuntosJornada(rotacion, partidos, apuestas, apostadoPor, plenoApuestas, dobleData);

      // La posición que se comunica es la de la CLASIFICACIÓN GENERAL acumulada hasta esta
      // jornada, no la del día — "4º esta jornada" confundía con la general, que es lo que de
      // verdad importa semana a semana.
      const general = await calcularClasificacionGeneral(jornada);
      const liderGeneral = general[0];
      const avisoPendiente = haySuspendidoPendiente ? ' · ⚠️ Falta un partido aplazado — puede variar' : '';
      const msg = `🏆 Jornada ${jornada} cerrada! Clasificación general — Líder: ${liderGeneral.nombre} con ${liderGeneral.pts}pts · Top 3: ${general.slice(0,3).map(r => `${r.nombre} ${r.pts}pts`).join(', ')}${avisoPendiente}`;

      for (const admin of ADMINS) {
        await callNotifications({
          tipo: 'resultado_jornada',
          jugador_id: admin, // clasificación completa: solo admins
          datos: { mensaje: msg }
        });
      }

      // Aviso individual: puntos de esta jornada + puesto y puntos en la general
      for (const jugadorId of JUGADORES) {
        const posGeneral = general.findIndex(r => r.id === jugadorId) + 1;
        const ptsGeneral = general.find(r => r.id === jugadorId)?.pts || 0;
        const ptsEstaJornada = puntosJornada[jugadorId] || 0;
        const indMsg = `🏆 Jornada ${jornada}: ${ptsEstaJornada}pts esta jornada · ${posGeneral}º en la general con ${ptsGeneral}pts`;
        await callNotifications({
          tipo: 'resultado_jornada',
          jugador_id: jugadorId,
          datos: { mensaje: indMsg }
        });
      }

      await supabase.from('jornada_estado').upsert({
        jornada,
        clave: notifCierreKey,
        valor: 'sent'
      });

      notifsSent.push('cierre_jornada');
    }

    // Marcador independiente del aviso de arriba: se pone a true en cuanto literalmente TODO
    // (incluidos los suspendidos) tiene resultado real — puede ocurrir en una pasada muy
    // posterior a la que mandó el resumen "provisional". Es lo único que decide si el cron dej
    // a de revisar esta jornada en jornadasPendientes (más abajo, en serve()); así el resultado
    // tardío de un aplazado se sigue detectando y notificando al jugador afectado aunque el
    // resumen de jornada ya se mandara hace semanas.
    if (todosTerminados) {
      await supabase.from('jornada_estado').upsert({
        jornada, clave: 'todos_resueltos', valor: 'true'
      }, { onConflict: 'jornada,clave' });
    }

    return {
      ok: true,
      jornada,
      partidosTerminados: partidos.filter(p => !p.pleno && p.c).length,
      totalPartidos: partidos.filter(p => !p.pleno).length,
      notifsSent
    };
}

serve(async (req) => {
  try {
    // 1. Jornada actual — robusto: si hay varias filas con esta clave (una por cada avance
    // histórico), nos quedamos con la de número de jornada más alto.
    const { data: jornadaState } = await supabase
      .from('jornada_estado')
      .select('valor')
      .eq('clave', 'jornada_actual')
      .order('jornada', { ascending: false })
      .limit(1)
      .maybeSingle();

    const jornadaActual = parseInt(jornadaState?.valor || '69');

    // 1b. Además de la jornada actual, revisamos cualquier jornada anterior que tenga
    // apuestas pero que aún no esté "todos_resueltos" — esto pasa cuando un partido queda
    // aplazado/suspendido: la jornada_actual ya avanzó (el resumen "provisional" puede llevar
    // semanas mandado), pero esa jornada vieja sigue con una casilla real pendiente. Ojo: NO se
    // usa notif_cierre_jornada aquí — ese aviso ya se manda en cuanto el calendario está
    // completo (puede haber un aplazado todavía sin jugar), así que dejaría de revisarse
    // justo cuando más falta hace seguir vigilando. Así, el día que ese partido se juegue, el
    // siguiente pase del cron detecta el resultado y avisa igualmente al jugador afectado,
    // aunque ya se lleven varias jornadas por delante.
    const { data: apuestasPasadas } = await supabase
      .from('apuestas')
      .select('jornada')
      .lt('jornada', jornadaActual);
    const jornadasConApuestas: number[] = Array.from(new Set((apuestasPasadas || []).map((a: any) => a.jornada as number)));

    let jornadasPendientes: number[] = [];
    if (jornadasConApuestas.length > 0) {
      const { data: resueltas } = await supabase
        .from('jornada_estado')
        .select('jornada')
        .eq('clave', 'todos_resueltos')
        .eq('valor', 'true')
        .in('jornada', jornadasConApuestas);
      const jornadasCerradas = new Set((resueltas || []).map((c: any) => c.jornada as number));
      jornadasPendientes = jornadasConApuestas.filter(j => !jornadasCerradas.has(j));
    }

    const jornadasARevisar: number[] = jornadasPendientes.sort((a, b) => a - b).concat([jornadaActual]);

    const resultados = [];
    for (const j of jornadasARevisar) {
      resultados.push(await procesarJornada(j, j === jornadaActual));
    }

    return new Response(JSON.stringify({ ok: true, jornadaActual, jornadasARevisar, resultados }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch(e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});