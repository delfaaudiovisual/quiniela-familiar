import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const API_KEY = Deno.env.get("LOTERIAS_API_KEY")!;
const BASE = "https://api.loteriasapi.com/api/v1";

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
}

function capitalize(str: string): string {
  if (!str) return "";
  if (str.toUpperCase() === 'EEUU' || str.toUpperCase() === 'EE.UU') return 'EE.UU.';
  return str.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function parsePartidos(html: string): { jornadaNum: number | null, partidos: any[] } {
  const partidos: any[] = [];

  // Extract jornada number
  const jMatch = html.match(/aria-label="Partidos programados jornada (\d+)"/i);
  const jornadaNum = jMatch ? parseInt(jMatch[1]) : null;

  // Split by partido-numero to get each row chunk
  const chunks = html.split('partido-numero');
  
  let lastPos = 0;
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i].substring(0, 800);
    
    const posMatch = chunk.match(/^[^>]*>(\d+)</);
    if (!posMatch) continue;
    const pos = parseInt(posMatch[1]);
    if (pos < 1 || pos > 15) continue;

    // Stop if we've already seen this position (means we're in a new jornada)
    if (pos <= lastPos && lastPos === 15) break;
    lastPos = pos;

    const localMatch = chunk.match(/class="local"[^>]*>(.*?)<\/span>/i);
    const visitMatch = chunk.match(/class="visitante"[^>]*>(.*?)<\/span>/i);
    const fechaMatch = chunk.match(/(\d{2}\/\d{2}\/\d{4})/);
    const horaMatch = chunk.match(/(\d{2}:\d{2})/);

    if (localMatch && visitMatch) {
      partidos.push({
        posicion: pos,
        l: capitalize(stripTags(localMatch[1])),
        v: capitalize(stripTags(visitMatch[1])),
        fecha: fechaMatch?.[1] || null,
        hora: horaMatch?.[1] || null,
        r: null,
        c: false,
      });
    }
    
    // Stop after pleno (position 15)
    if (pos === 15) break;
  }

  return { jornadaNum, partidos };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const res = await fetch("https://www.quinielafutbol.info/proximas-jornadas-de-la-quiniela.html", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "text/html",
        "Accept-Language": "es-ES,es;q=0.9",
      }
    });

    if (res.ok) {
      const html = await res.text();
      const { jornadaNum, partidos } = parsePartidos(html);

      if (partidos.length >= 14) {
        const regular = partidos.filter(p => p.posicion <= 14).map(p => ({
          l: p.l, v: p.v, r: null, c: false, fecha: p.fecha, hora: p.hora
        }));
        const pleno = partidos.find(p => p.posicion === 15);
        regular.push({
          l: pleno?.l || "Pleno al 15",
          v: pleno?.v || "",
          r: null, c: false, pleno: true,
          fecha: pleno?.fecha, hora: pleno?.hora
        });

        return new Response(JSON.stringify({
          jornadaNum, source: "quinielafutbol", partidos: regular,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({
        debug: true, jornadaNum, encontrados: partidos.length, muestra: partidos.slice(0,3)
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Fallback
    const latestRes = await fetch(`${BASE}/results/quiniela/latest`, { headers: { "X-API-Key": API_KEY } });
    const latestJson = await latestRes.json();
    const lp = latestJson.data?.resultData?.partidos || [];
    const parsed = lp.slice(0, 14).map((p: any) => ({
      l: capitalize(p.local), v: capitalize(p.visitante), r: p.signo || null, c: !!p.signo,
    }));
    const pleno = lp.find((p: any) => p.posicion === 15);
    parsed.push({ l: capitalize(pleno?.local || "Pleno al 15"), v: capitalize(pleno?.visitante || ""), r: null, c: false, pleno: true });

    return new Response(JSON.stringify({ source: "loteriasapi_fallback", partidos: parsed }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 });
  }
});
