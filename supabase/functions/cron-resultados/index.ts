import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const SUPA_FUNCTIONS_URL = Deno.env.get("SUPABASE_URL")!.replace('.supabase.co', '.supabase.co/functions/v1');
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const JUGADORES = ['deborah','alexander','virginia','ivan','jonathan','daniel','nines','felix','mari','javier'];
const ADMINS = ['felix'];
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

function getOrden(jornada: number): string[] {
  const n = ORDEN0.length; // 15
  const offset = (jornada - 1) % n;
  return [...ORDEN0.slice(offset), ...ORDEN0.slice(0, offset)];
}

function getPos(id: string, jornada: number): number {
  const orden = getOrden(jornada);
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

async function getPartidos(jornada: number): Promise<any[]> {
  try {
    const res = await fetch(`${SUPA_FUNCTIONS_URL}/quiniela-jornada`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ jornadaHistorica: jornada })
    });
    const data = await res.json();
    return data.partidos || [];
  } catch(e) {
    console.error('Error getting partidos:', e);
    return [];
  }
}

serve(async (req) => {
  try {
    // 1. Get current jornada from DB state
    const { data: jornadaState } = await supabase
      .from('jornada_estado')
      .select('clave,valor')
      .eq('clave', 'jornada_actual');

    const jornada = parseInt(jornadaState?.[0]?.valor || '69');

    // 2. Get partidos for this jornada
    const partidos = await getPartidos(jornada);
    if (partidos.length === 0) {
      return new Response(JSON.stringify({ ok: true, msg: 'No partidos', jornada }));
    }

    // 3. Get apuestas for this jornada
    const { data: apuestasData } = await supabase
      .from('apuestas')
      .select('jugador_id,apuesta,apostado_por')
      .eq('jornada', jornada);

    const apuestas: Record<string,string> = {};
    const apostadoPor: Record<string,string> = {};
    (apuestasData || []).forEach((a: any) => {
      apuestas[a.jugador_id] = a.apuesta;
      if (a.apostado_por) apostadoPor[a.jugador_id] = a.apostado_por;
    });

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

    const notifsSent: string[] = [];

    // 5. For each jugador, check if their partido AND pareja partido have finished
    for (const jugadorId of JUGADORES) {
      const posInd = getPos(jugadorId, jornada);
      const ptInd = partidos[posInd - 1];
      if (!ptInd || ptInd.pleno) continue;

      const apuestaInd = apuestas[jugadorId];
      if (!apuestaInd) continue; // didn't bet

      const parejaId = getParejaId(jugadorId);
      const posPar = getPos(parejaId, jornada);
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

    // 6. Check if ALL partidos finished → send ranking notification + advance jornada
    const notifCierreKey = `notif_cierre_jornada`;
    const todosTerminados = partidos.filter(p => !p.pleno).every(p => p.c && p.r);

    // Auto-advance jornada when all partidos closed + 8h wait
    if (todosTerminados) {
      const cierreKey = `jornada_cerrada_at`;
      const { data: cierreData } = await supabase
        .from('jornada_estado')
        .select('valor')
        .eq('jornada', jornada)
        .eq('clave', cierreKey)
        .single();

      const now = Date.now();

      if (!cierreData) {
        // First time we detect all closed — record the timestamp
        await supabase.from('jornada_estado').upsert({
          jornada, clave: cierreKey, valor: String(now)
        });
        console.log('Jornada', jornada, 'cerrada a las', new Date(now).toISOString());
      } else {
        // Check if 8 hours have passed since closure
        const closedAt = parseInt(cierreData.valor);
        const horasTranscurridas = (now - closedAt) / (1000 * 60 * 60);

        if (horasTranscurridas >= 8) {
          // Check if next jornada exists in Eduardo Losilla
          const nextJornada = jornada + 1;
          try {
            const nextRes = await fetch(
              `${SUPA_FUNCTIONS_URL}/quiniela-jornada`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_KEY}` },
                body: JSON.stringify({ jornadaHistorica: nextJornada })
              }
            );
            const nextData = await nextRes.json();
            if (nextData.partidos && nextData.partidos.length >= 13) {
              await supabase.from('jornada_estado').upsert({
                jornada: nextJornada,
                clave: 'jornada_actual',
                valor: String(nextJornada)
              });
              console.log('Avanzando a jornada', nextJornada, 'tras', horasTranscurridas.toFixed(1), 'horas');
              await callNotifications({
                tipo: 'resultado_jornada',
                jugador_id: ADMINS[0],
                datos: { mensaje: `🆕 Jornada ${nextJornada} disponible. Ya se puede apostar.` }
              });
            }
          } catch(e) { console.error('Error checking next jornada:', e); }
        } else {
          console.log('Jornada', jornada, 'cerrada pero esperando', (8 - horasTranscurridas).toFixed(1), 'horas más');
        }
      }
    }

    if (todosTerminados && !notifEnviadas.has(notifCierreKey)) {
      // Calculate points for each player
      const puntos: Record<string, number> = {};
      for (const jugadorId of JUGADORES) {
        let pts = 0;
        const posInd = getPos(jugadorId, jornada);
        const ptInd = partidos[posInd - 1];
        if (ptInd) {
          if (ptInd.pleno) {
            pts += puntosPleno(ptInd, plenoApuestas[jugadorId], false);
          } else if (ptInd.c && ptInd.r && apuestas[jugadorId] && !apostadoPor[jugadorId]) {
            if (apuestas[jugadorId] === ptInd.r) pts += 1;
          }
        }

        // Pareja
        const parejaId = getParejaId(jugadorId);
        const posPar = getPos(parejaId, jornada);
        const ptPar = posPar > 0 ? partidos[posPar - 1] : null;
        if (ptPar) {
          if (ptPar.pleno) {
            pts += puntosPleno(ptPar, plenoApuestas[parejaId], true);
          } else if (ptPar.c && ptPar.r && apuestas[parejaId] && !apostadoPor[parejaId]) {
            if (apuestas[parejaId] === ptPar.r) pts += 0.5;
          }
        }

        puntos[jugadorId] = pts;
      }

      // El Doble
      if (dobleData && dobleData.casilla >= 1 && dobleData.casilla <= 14) {
        const ptDoble = partidos[dobleData.casilla - 1];
        if (ptDoble && ptDoble.c && ptDoble.r) {
          const acierta = dobleData.apuesta === ptDoble.r;
          if (puntos[dobleData.jugador_id] !== undefined) {
            puntos[dobleData.jugador_id] += acierta ? 1 : -0.5;
          }
          if (acierta) {
            const duenoId = getOrden(jornada)[dobleData.casilla - 1];
            const duenoPareja = PAREJAS[duenoId];
            if (duenoPareja) {
              duenoPareja.jugadores.forEach((mId) => { if (puntos[mId] !== undefined) puntos[mId] += 0.5; });
            } else if (puntos[duenoId] !== undefined) {
              puntos[duenoId] += 0.5;
            }
          }
        }
      }

      // Sort by points
      const ranking = JUGADORES
        .map(j => ({ id: j, nombre: NOMBRES[j], pts: puntos[j] || 0 }))
        .sort((a, b) => b.pts - a.pts);

      const lider = ranking[0];
      const msg = `🏆 Jornada ${jornada} cerrada! Líder: ${lider.nombre} con ${lider.pts}pts · Top 3: ${ranking.slice(0,3).map(r => `${r.nombre} ${r.pts}pts`).join(', ')}`;

      await callNotifications({
        tipo: 'resultado_jornada',
        jugador_id: ADMINS[0], // clasificación completa: solo admin
        datos: { mensaje: msg }
      });

      // Also send individual results to each player
      for (const jugador of ranking) {
        const pos = ranking.indexOf(jugador) + 1;
        const indMsg = `🏆 Jornada ${jornada}: ${pos}º puesto · ${jugador.pts}pts esta jornada`;
        await callNotifications({
          tipo: 'resultado_jornada',
          jugador_id: jugador.id,
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

    return new Response(JSON.stringify({
      ok: true,
      jornada,
      partidosTerminados: partidos.filter(p => !p.pleno && p.c).length,
      totalPartidos: partidos.filter(p => !p.pleno).length,
      notifsSent
    }), { headers: { 'Content-Type': 'application/json' } });

  } catch(e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});