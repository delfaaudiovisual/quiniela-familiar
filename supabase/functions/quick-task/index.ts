// ============================================================
// SUPABASE EDGE FUNCTION: quick-task
// (sube este archivo a esa función concreta en el dashboard)
// ============================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Sin esto, el preflight OPTIONS que manda el navegador en toda petición cross-origin con
// Content-Type/Authorization personalizados llegaba sin body al handler normal, reventaba en
// req.json() ("Unexpected end of JSON input") y, aunque quedara capturado, la respuesta no
// llevaba las cabeceras CORS que el navegador exige para aceptar el preflight — así que la
// petición real (ej. "Saltar" de Felix) nunca llegaba a mandarse. quiniela-jornada ya lo hacía
// bien; a quick-task se le había olvidado.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = "mailto:delfa.audiovisual@gmail.com";

const JUGADORES = ['deborah','alexander','virginia','ivan','jonathan','daniel','nines','felix','mari','javier'];
const PAREJAS = ['p1','p2','p3','p4','p5'];
// TEMPORAL: 'daniel' añadido para no depender solo de Felix mientras se resuelve el bug de hoy —
// quitarlo cuando esté solucionado (coincide con ADMINS en index.html y cron-resultados).
const ADMINS = ['felix', 'daniel'];
const NOMBRES: Record<string, string> = {
  deborah:'Deborah', alexander:'Alexander', virginia:'Virginia', ivan:'Ivan',
  jonathan:'Jonathan', daniel:'Daniel', nines:'Nines', felix:'Felix',
  mari:'Mari', javier:'Javier'
};
// Miembros de cada pareja — hace falta cuando el turno del Doble (getJugadorDoble) le cae a una
// pareja entera (id tipo 'p1'..'p5') en vez de a un jugador individual, para poder avisar a los
// dos a la vez (igual que PAREJAS en cron-resultados / PP en index.html).
const PAREJAS_MIEMBROS: Record<string, [string, string]> = {
  p1: ['mari','javier'], p2: ['nines','felix'], p3: ['jonathan','daniel'],
  p4: ['virginia','alexander'], p5: ['deborah','ivan'],
};
// 15 posiciones: 10 individuales + 5 parejas — coincide con ORDEN0 de index.html / cron-resultados
const ORDEN0 = ['javier','mari','felix','nines','daniel','jonathan','ivan','virginia','alexander','deborah','p1','p2','p3','p4','p5'];

function getJugadorDoble(rotacion: number): string {
  const n = ORDEN0.length;
  const offset = (rotacion - 1) % n;
  return ORDEN0[offset];
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);
const SUPA_FUNCTIONS_URL = Deno.env.get("SUPABASE_URL")!.replace('.supabase.co', '.supabase.co/functions/v1');
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Mismo chequeo que hace cron-resultados para una jornada "saltada": si la SIGUIENTE ya tiene
// datos publicados en Eduardo Losilla, no hace falta esperar al próximo tick del cron — se
// comprueba aquí mismo, al momento de saltar, para que si ya está lista (como pasó con la 5→6)
// se le pregunte a Felix encadenado, sin esperar.
async function jornadaTieneDatos(jornada: number): Promise<boolean> {
  try {
    const res = await fetch(`${SUPA_FUNCTIONS_URL}/quiniela-jornada`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ jornadaHistorica: jornada })
    });
    const data = await res.json();
    // No basta con contar filas (>=13): Eduardo Losilla puede tardar horas en terminar de
    // publicar el calendario real de una jornada nueva, y mientras tanto su página puede
    // devolver algo provisional con partidos de Selecciones/Copa que igualmente cuenta 13+ filas.
    // jornadaValida (misma comprobación que usa la pantalla normal: suficientes equipos de
    // Primera + días de fin de semana) es lo que de verdad distingue "ya está lista" de "todavía
    // no" — sin esto, se podía encadenar la pregunta a Felix con una jornada que en realidad no
    // tenía pinta de ser una jornada normal de LaLiga.
    return !!(data.partidos && data.partidos.length >= 13 && data.jornadaValida);
  } catch(e) {
    console.error('Error comprobando datos de jornada', jornada, e);
    return false;
  }
}

// Traduce un número de jornada de LaLiga a la "ronda real" de la familia — solo avanza cuando
// una jornada se juega de verdad (mismo concepto que en index.html/cron-resultados). Sin fila
// explícita, se asume que coincide con el propio número de jornada.
async function getRotacion(jornada: number): Promise<number> {
  // .limit(1) en vez de .maybeSingle() — si por lo que sea llegara a haber más de una fila,
  // no revienta, simplemente coge una en vez de fallar.
  const { data } = await supabase
    .from('jornada_estado')
    .select('valor')
    .eq('jornada', jornada)
    .eq('clave', 'rotacion')
    .limit(1);
  const r = data?.[0]?.valor ? parseInt(data[0].valor) : null;
  return r != null && !isNaN(r) ? r : jornada;
}

async function sendPush(subscription: any, payload: object) {
  // El import dinámico tiene que ir DENTRO del try — si esm.sh falla o se cuelga justo para una
  // de las suscripciones (ej. mandando el aviso de "saltar" a todo el mundo, una a una), antes
  // reventaba sin capturarlo y tiraba abajo toda la petición con un 500 — eso es lo que le salió
  // a Felix como "error de servidor" al saltar jornada.
  try {
    const { default: webpush } = await import("https://esm.sh/web-push@3.6.7");
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return true;
  } catch(e) {
    console.error("Push error:", e);
    return false;
  }
}

async function notificar(jugadorIds: string[] | null, payload: object) {
  let query = supabase.from("push_subscriptions").select("*");
  if (jugadorIds) query = query.in("jugador_id", jugadorIds);
  const { data } = await query;
  if (!data) return;
  for (const row of data) await sendPush(row.subscription, payload);
}

async function todosHanApostado(jornada: number): Promise<boolean> {
  const { data: apuestas } = await supabase
    .from("apuestas")
    .select("jugador_id")
    .eq("jornada", jornada);

  const { data: estados } = await supabase
    .from("jornada_estado")
    .select("clave,valor")
    .eq("jornada", jornada);

  if (!apuestas) return false;

  const apostados = new Set(apuestas.map((a: any) => a.jugador_id));

  // Check all 10 individuals have bet
  const todosInd = JUGADORES.every(j => apostados.has(j));
  if (!todosInd) return false;

  // Check all 5 parejas - either bet or one member skipped (other must have bet)
  const skips = new Set((estados || [])
    .filter((e: any) => e.clave.startsWith('_skip_'))
    .map((e: any) => e.clave.replace('_skip_', '')));

  const todasParejas = PAREJAS.every(p => apostados.has(p) || skips.has(p));
  return todasParejas;
}

async function generarResumenPareja(jornada: number): Promise<string> {
  const { data: apuestas } = await supabase
    .from("apuestas")
    .select("jugador_id,apuesta")
    .eq("jornada", jornada);

  if (!apuestas) return "Ya puedes rellenar la quiniela.";

  const map: Record<string, string> = {};
  apuestas.forEach((a: any) => { map[a.jugador_id] = a.apuesta; });

  const lineas = Object.entries(map)
    .filter(([k]) => JUGADORES.includes(k))
    .map(([k, v]) => `${NOMBRES[k]}: ${v}`)
    .join(', ');

  return `Todos apostados 🎯 ${lineas}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
  const body = await req.json().catch(() => ({}));
  const { tipo, jugador_id, jornada = 1, datos } = body;

  switch(tipo) {

    case "comprobar_todos_apostaron": {
      // Llamado desde el HTML cada vez que alguien confirma una apuesta, cede el turno,
      // apuesta por otro, o confirma el doble.
      const todos = await todosHanApostado(jornada);
      if (!todos) {
        return new Response(JSON.stringify({ ok: true, todos: false }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const rotacion = await getRotacion(jornada);
      const dobleId = getJugadorDoble(rotacion);
      const { data: dobleData } = await supabase
        .from("apuestas_doble")
        .select("jugador_id")
        .eq("jornada", jornada)
        .maybeSingle();

      if (!dobleData) {
        // Faltan las 15 casillas base ya están cubiertas, pero falta el doble.
        // Solo avisamos a quien le toca el doble — Felix espera hasta que el doble esté puesto.
        // El turno puede caer en un jugador individual o en una pareja entera (id 'p1'..'p5');
        // en ese caso avisamos a los dos miembros, ya que cualquiera de los dos puede ponerlo
        // (o cedérselo al otro desde la app, igual que con la apuesta de pareja normal).
        const { data: yaAvisado } = await supabase
          .from("jornada_estado")
          .select("valor")
          .eq("jornada", jornada)
          .eq("clave", "notif_doble_turno")
          .maybeSingle();
        if (!yaAvisado) {
          const miembrosPareja = PAREJAS_MIEMBROS[dobleId];
          const destinatarios = miembrosPareja ? [...miembrosPareja] : [dobleId];
          const nombreDoble = miembrosPareja
            ? miembrosPareja.map(id => NOMBRES[id]).join(' & ')
            : (NOMBRES[dobleId] || dobleId);
          const body = miembrosPareja
            ? `${nombreDoble}, esta semana os toca el Doble como pareja — cualquiera de los dos puede ponerlo.`
            : `${nombreDoble}, esta semana te toca el Doble — ¡ya puedes ponerlo!`;
          await notificar(destinatarios, {
            title: "🎯 Te toca el Doble - La Piripiniela",
            body,
            icon: "/icon.png",
            url: "/"
          });
          await supabase.from("jornada_estado").upsert({ jornada, clave: "notif_doble_turno", valor: "sent" });
        }
      } else {
        // Todo completo de verdad, incluido el doble: ahora sí avisamos a Felix.
        const { data: yaAvisadoFelix } = await supabase
          .from("jornada_estado")
          .select("valor")
          .eq("jornada", jornada)
          .eq("clave", "notif_todo_listo")
          .maybeSingle();
        if (!yaAvisadoFelix) {
          const resumen = await generarResumenPareja(jornada);
          await notificar(ADMINS, {
            title: "✅ Todo listo - La Piripiniela",
            body: `Todos han apostado, incluido el doble. ${resumen}`,
            icon: "/icon.png",
            url: "/"
          });
          await supabase.from("jornada_estado").upsert({ jornada, clave: "notif_todo_listo", valor: "sent" });
        }
      }

      return new Response(JSON.stringify({ ok: true, todos: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    case "var_solicitado": {
      await notificar(ADMINS, {
        title: "🟡 VAR - La Piripiniela",
        body: datos?.mensaje || "Se ha solicitado el VAR.",
        icon: "/icon.png",
        url: "/"
      });
      break;
    }

    case "aviso_general": {
      // Aviso puntual a todos los jugadores (ej. arranque de temporada, o "hay novedades" con
      // datos.url tipo "/?novedades=1" para que la app sepa que viene de este aviso concreto),
      // disparado a mano.
      //
      // datos.excluirNovedadesVersion (ej. "v1"): si se manda, no se avisa a quien el propio
      // index.html ya haya marcado en jornada_estado como "novedades_v1_<jugador>" (lo hace al
      // abrir el carrusel) — para no repetirle un aviso de algo que ya vio por su cuenta.
      let destinatarios: string[] | null = null;
      if (datos?.excluirNovedadesVersion) {
        const prefijo = `novedades_${datos.excluirNovedadesVersion}_`;
        const { data: vistos } = await supabase
          .from('jornada_estado')
          .select('clave')
          .eq('jornada', 0)
          .like('clave', `${prefijo}%`);
        const yaVieron = new Set((vistos || []).map((r: any) => r.clave.slice(prefijo.length)));
        destinatarios = JUGADORES.filter(j => !yaVieron.has(j));
        if (destinatarios.length === 0) {
          return new Response(JSON.stringify({ ok: true, msg: 'Todos ya habían visto esta versión, no se manda nada' }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      }
      await notificar(destinatarios, {
        title: datos?.titulo || "📣 La Piripiniela",
        body: datos?.mensaje || "",
        icon: "/icon.png",
        url: datos?.url || "/"
      });
      break;
    }

    case "apuestas_cerradas": {
      // Llamado por cron el jueves 22h
      await notificar(null, {
        title: "🔒 La Piripiniela",
        body: "Las apuestas han cerrado. ¡Suerte a todos!",
        icon: "/icon.png",
        url: "/"
      });
      break;
    }

    case "aviso_pareja": {
      if (jugador_id) {
        await notificar([jugador_id], {
          title: "👫 La Piripiniela",
          body: datos?.mensaje || "Tu pareja ya apostó. Recuerda poner la apuesta de pareja.",
          icon: "/icon.png",
          url: "/"
        });
      }
      break;
    }

    case "resultado_jornada": {
      if (jugador_id && datos?.mensaje) {
        await notificar([jugador_id], {
          title: "⚽ Jornada cerrada - La Piripiniela",
          body: datos.mensaje,
          icon: "/icon.png",
          url: "/"
        });
      }
      break;
    }

    case "confirmar_jornada": {
      // Solo un admin puede abrir/saltar jornada — se comprueba aquí también, no solo en la app.
      if (!ADMINS.includes(jugador_id)) {
        return new Response(JSON.stringify({ error: "Solo el admin puede confirmar la jornada" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      const accion = datos?.accion; // 'abrir' | 'saltar'
      if (accion !== 'abrir' && accion !== 'saltar') {
        return new Response(JSON.stringify({ error: "accion inválida" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // La jornada realmente pendiente de confirmar según la base de datos — no nos fiamos de
      // lo que mande el cliente, por si hay alguna desincronización con lo que ve en pantalla.
      const { data: pendientes } = await supabase
        .from('jornada_estado')
        .select('jornada')
        .eq('clave', 'pendiente_confirmacion')
        .eq('valor', 'true')
        .order('jornada', { ascending: false })
        .limit(1);
      const jornadaPendiente = pendientes?.[0]?.jornada;
      if (jornadaPendiente == null) {
        return new Response(JSON.stringify({ ok: true, msg: 'No hay ninguna jornada pendiente de confirmar' }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      await supabase.from('jornada_estado').delete().eq('jornada', jornadaPendiente).eq('clave', 'pendiente_confirmacion');

      const rotacionCerrada = await getRotacion(jornadaPendiente);
      // Siempre avanza de una en una jornada real de LaLiga, se juegue o se salte — nunca de
      // golpe. Así, cuando esta nueva jornada cierre de verdad (per Eduardo Losilla), se vuelve
      // a preguntar a Felix por la siguiente, sin saltarse ningún número por el camino.
      const nuevaJornada = jornadaPendiente + 1;

      await supabase.from('jornada_estado').upsert({
        jornada: nuevaJornada, clave: 'jornada_actual', valor: String(nuevaJornada)
      }, { onConflict: 'jornada,clave' });

      if (accion === 'abrir') {
        // La rotación avanza un paso real — se consume turno.
        await supabase.from('jornada_estado').upsert({
          jornada: nuevaJornada, clave: 'rotacion', valor: String(rotacionCerrada + 1)
        }, { onConflict: 'jornada,clave' });
        // El aviso de "jornada abierta" YA NO se manda aquí al momento — se probaron dos
        // extremos y los dos fallaban: mandarlo al instante llegaba antes de que Eduardo Losilla
        // terminara de publicar el calendario real (horas de desfase; la gente clicaba el aviso
        // y no había nada que apostar todavía), y una espera fija de 12h llegaba tarde al revés
        // (ya llevaban horas apostando con normalidad cuando saltaba el aviso). En vez de adivinar
        // un tiempo fijo, se deja marcado aquí y es cron-resultados quien lo manda en cuanto
        // confirma que los datos ya son jornadaValida de verdad (ver ese archivo).
        await supabase.from('jornada_estado').upsert({
          jornada: nuevaJornada, clave: 'pendiente_notif_abierta', valor: 'true'
        }, { onConflict: 'jornada,clave' });
      } else {
        // "Saltar": nadie apuesta esta jornada. La rotación se copia IGUAL, sin avanzar — así
        // no consume turno de nadie (se escribe explícitamente, en vez de dejar la fila vacía,
        // para que cualquier lectura futura de esta jornada — cron, frontend — encuentre
        // siempre un valor y no tenga que adivinar). El cron sigue vigilando esta jornada con
        // la misma lógica de siempre (calendarioCompleto/todosTerminados, suspendidos
        // incluidos) hasta que cierre de verdad y se vuelva a preguntar a Felix.
        await supabase.from('jornada_estado').upsert({
          jornada: nuevaJornada, clave: 'rotacion', valor: String(rotacionCerrada)
        }, { onConflict: 'jornada,clave' });
        await supabase.from('jornada_estado').upsert({
          jornada: nuevaJornada, clave: 'saltada', valor: 'true'
        }, { onConflict: 'jornada,clave' });

        // Al saltar no se avisa a nadie: no hay nada que hacer para los jugadores (no se apuesta
        // esta jornada), así que el aviso de "saltamos por X motivo" solo era ruido. El único
        // aviso que de verdad hace falta es el de más abajo, a los admins, cuando la SIGUIENTE
        // jornada ya tiene datos listos para decidir — sin eso nadie sabría que toca actuar.

        // Como nadie apuesta en una jornada saltada, no hace falta esperar a que sus partidos
        // reales (a veces de Champions/selecciones, con calendario propio) acaben del todo antes
        // de preguntar por la siguiente — solo a que ESA ya tenga datos. Se comprueba aquí mismo,
        // en vez de esperar al próximo tick del cron, para que si ya está lista (como pasó con la
        // 5→6) el admin encadene la decisión al momento.
        if (await jornadaTieneDatos(nuevaJornada + 1)) {
          const now = Date.now();
          await supabase.from('jornada_estado').upsert({
            jornada: nuevaJornada, clave: 'jornada_cerrada_at', valor: String(now)
          }, { onConflict: 'jornada,clave' });
          await supabase.from('jornada_estado').upsert({
            jornada: nuevaJornada, clave: 'pendiente_confirmacion', valor: 'true'
          }, { onConflict: 'jornada,clave' });
          await notificar(ADMINS, {
            title: "🏁 La Piripiniela",
            body: `Saltamos la jornada ${nuevaJornada}, pero ya está disponible la ${nuevaJornada + 1}. ¿La jugamos? Pulsa y dime si abrimos apuestas o la saltamos también.`,
            icon: "/icon.png", url: "/"
          });
        }
      }

      return new Response(JSON.stringify({ ok: true, accion, jornada: nuevaJornada }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    default:
      return new Response(JSON.stringify({ error: "tipo desconocido" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
  } catch(e: any) {
    // Cualquier fallo inesperado vuelve como JSON en vez de tirar un 500 en blanco — así el
    // cliente (ej. la app de Felix) siempre puede leer data.error en vez de que res.json()
    // reviente y se quede con el genérico "error de conexión".
    console.error('Error en quick-task:', e);
    return new Response(JSON.stringify({ error: e.message || 'Error desconocido' }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});