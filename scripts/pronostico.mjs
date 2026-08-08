// Genera el pronóstico de asistencia y evangelismo de Casa De Dios.
// Se ejecuta automáticamente vía GitHub Actions (ver .github/workflows/pronostico.yml):
//   - Todos los viernes a la mañana: `node pronostico.mjs semanal`
//   - El día 1 de cada mes:          `node pronostico.mjs mensual`
//   - Cada hora:                     `node pronostico.mjs eventos` (analiza eventos/campañas
//                                     de evangelismo cargados a mano, para cualquier fecha)
//
// Usa Open-Meteo (gratis, sin clave) para el clima y, si hay una clave configurada,
// la API gratuita de Gemini (con búsqueda web) para sugerir el mejor día/zonas de
// evangelismo y el resumen mensual. Si falta GEMINI_API_KEY o se agota la cuota
// gratuita, el documento se guarda igual con la parte de clima y un estado que
// la app muestra como aviso, sin romper nada.

import admin from 'firebase-admin';

const TRES_ARROYOS = { lat: -38.3739, lng: -60.2761 };
const TIMEZONE = 'America/Argentina/Buenos_Aires';
const GEMINI_MODEL = 'gemini-2.5-flash';

// No hay un conteo real de asistencia, así que no mostramos un número:
// mostramos una TENDENCIA ("más/menos/similar a lo habitual"). Estos valores
// aproximados solo se usan como contexto para que la IA calibre su criterio.
const ASISTENCIA_HABITUAL = { viernes: 60, sabado: 60, domingoManana: 200, domingoNoche: 300 };
const ETIQUETAS_DIA = { viernes: 'viernes', sabado: 'sábado', domingoManana: 'domingo a la mañana', domingoNoche: 'domingo a la noche' };

const ZONAS_FALLBACK = [
  { nombre: 'Plaza San Martín', lat: -38.3745, lng: -60.2758, horario: '18:00 - 20:30', motivo: 'Plaza céntrica, paseo habitual de fin de semana' },
  { nombre: 'Costanera del Arroyo', lat: -38.3800, lng: -60.2700, horario: '17:30 - 19:30', motivo: 'Alta circulación de familias y jóvenes' },
];

const WMO = {
  0: 'Despejado', 1: 'Mayormente despejado', 2: 'Parcialmente nublado', 3: 'Nublado',
  45: 'Niebla', 48: 'Niebla con escarcha',
  51: 'Llovizna leve', 53: 'Llovizna moderada', 55: 'Llovizna intensa',
  61: 'Lluvia leve', 63: 'Lluvia moderada', 65: 'Lluvia intensa',
  71: 'Nieve leve', 73: 'Nieve moderada', 75: 'Nieve intensa',
  80: 'Chubascos leves', 81: 'Chubascos moderados', 82: 'Chubascos intensos',
  95: 'Tormenta', 96: 'Tormenta con granizo', 99: 'Tormenta fuerte con granizo',
};

function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Falta el secret FIREBASE_SERVICE_ACCOUNT');
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return admin.firestore();
}

async function obtenerClimaSemana() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${TRES_ARROYOS.lat}&longitude=${TRES_ARROYOS.lng}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=${encodeURIComponent(TIMEZONE)}&forecast_days=7`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo respondió ${res.status}`);
  const data = await res.json();
  const d = data.daily;
  return d.time.map((fecha, i) => ({
    fecha,
    weathercode: d.weather_code[i],
    descripcion: WMO[d.weather_code[i]] || 'Clima variable',
    tempMax: d.temperature_2m_max[i],
    tempMin: d.temperature_2m_min[i],
    probLluvia: d.precipitation_probability_max[i],
  }));
}

function tendenciaPorClima(probLluvia) {
  if (probLluvia >= 60) return { tendencia: 'menos', mensaje: 'Alta probabilidad de lluvia: es probable que asistan menos personas de lo habitual.' };
  if (probLluvia >= 30) return { tendencia: 'menos', mensaje: 'Hay chance de lluvia: podrían venir algunas personas menos de lo habitual.' };
  if (probLluvia <= 5) return { tendencia: 'mas', mensaje: 'Buen clima despejado: es probable que asistan más personas de lo habitual.' };
  return { tendencia: 'normal', mensaje: 'Clima estable: se espera una asistencia similar a la habitual.' };
}

function calcularDiaTendencia(clima) {
  return {
    ...tendenciaPorClima(clima.probLluvia),
    clima: { descripcion: clima.descripcion, tempMax: clima.tempMax, probLluvia: clima.probLluvia },
  };
}

async function generarConIA(ai, prompt, schema) {
  const interaction = await ai.interactions.create({
    model: GEMINI_MODEL,
    input: prompt,
    tools: [{ type: 'google_search' }],
    response_format: { type: 'text', mime_type: 'application/json', schema },
  });
  if (!interaction.output_text) throw new Error('La IA no devolvió una respuesta de texto');
  return JSON.parse(interaction.output_text);
}

async function generarSemanal(db) {
  const clima = await obtenerClimaSemana();
  const [climaViernes, climaSabado, climaDomingo] = clima;

  // Base determinada solo por clima — siempre disponible, sin costo.
  const diasClima = {
    viernes: calcularDiaTendencia(climaViernes),
    sabado: calcularDiaTendencia(climaSabado),
    domingoManana: calcularDiaTendencia(climaDomingo),
    domingoNoche: calcularDiaTendencia(climaDomingo),
  };

  let dias = diasClima;
  let evangelismo = null;
  let estado = 'pendiente';
  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey) {
    try {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey });
      const candidatos = clima.filter((_, i) => i !== 2).map((c) => c.fecha); // toda la semana menos el domingo
      const contextoHabitual = Object.entries(ASISTENCIA_HABITUAL)
        .map(([clave, n]) => `${ETIQUETAS_DIA[clave]}: unas ${n} personas`).join('; ');
      const contextoClima = Object.entries(diasClima)
        .map(([clave, d]) => `${ETIQUETAS_DIA[clave]} (${d.clima.descripcion}, ${d.clima.probLluvia}% de lluvia): tendencia solo por clima = "${d.tendencia}"`).join('. ');
      const prompt = `Sos un asistente que ayuda a una iglesia evangélica ("Casa De Dios") en Tres Arroyos, Argentina.
Asistencia habitual aproximada por franja: ${contextoHabitual}.
Tendencia calculada solo por el clima de esta semana: ${contextoClima}.

Tarea 1 — Asistencia: para viernes, sábado, domingo a la mañana y domingo a la noche de esta semana, buscá noticias y eventos locales de Tres Arroyos (ferias, fiestas patronales, eventos deportivos, feriados) que puedan influir en la asistencia, además del clima ya calculado. Para cada una de las 4 franjas, indicá una tendencia ("mas", "menos" o "normal") respecto a lo habitual y un mensaje corto explicando por qué. Si no encontrás nada relevante más allá del clima, mantené la tendencia igual a la calculada por clima.

Tarea 2 — Evangelismo: buscá noticias y eventos locales de Tres Arroyos para la semana del ${clima[0].fecha} al ${clima[6].fecha}. Con esa información, elegí UNA fecha de esta lista como la mejor para salir a evangelizar en lugares PÚBLICOS: ${candidatos.join(', ')}. Sugerí también 2 o 3 zonas públicas reales de Tres Arroyos (plazas, veredas céntricas, parques, costanera — NUNCA lugares privados como canchas de fútbol privadas o clubes) con el horario aproximado de mayor circulación de gente y sus coordenadas geográficas aproximadas (latitud/longitud).

Si no encontrás información específica, basate en el conocimiento general de la ciudad, el calendario y el clima. No inventes eventos que no existan.`;
      const schemaDia = {
        type: 'object',
        properties: {
          tendencia: { type: 'string', enum: ['mas', 'menos', 'normal'] },
          mensaje: { type: 'string' },
        },
        required: ['tendencia', 'mensaje'],
        additionalProperties: false,
      };
      const schema = {
        type: 'object',
        properties: {
          diasAjuste: {
            type: 'object',
            properties: { viernes: schemaDia, sabado: schemaDia, domingoManana: schemaDia, domingoNoche: schemaDia },
            required: ['viernes', 'sabado', 'domingoManana', 'domingoNoche'],
            additionalProperties: false,
          },
          evangelismo: {
            type: 'object',
            properties: {
              mejorDia: { type: 'string', description: 'Una de las fechas candidatas, en formato legible en español (ej: "Sábado 9 de agosto")' },
              motivo: { type: 'string' },
              zonas: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    nombre: { type: 'string' },
                    lat: { type: 'number' },
                    lng: { type: 'number' },
                    horario: { type: 'string' },
                    motivo: { type: 'string' },
                  },
                  required: ['nombre', 'lat', 'lng', 'horario', 'motivo'],
                  additionalProperties: false,
                },
              },
            },
            required: ['mejorDia', 'motivo', 'zonas'],
            additionalProperties: false,
          },
        },
        required: ['diasAjuste', 'evangelismo'],
        additionalProperties: false,
      };
      const resultado = await generarConIA(ai, prompt, schema);
      // Conservamos el objeto "clima" (viene de Open-Meteo) y usamos la tendencia/mensaje de la IA.
      dias = {
        viernes: { ...diasClima.viernes, ...resultado.diasAjuste.viernes },
        sabado: { ...diasClima.sabado, ...resultado.diasAjuste.sabado },
        domingoManana: { ...diasClima.domingoManana, ...resultado.diasAjuste.domingoManana },
        domingoNoche: { ...diasClima.domingoNoche, ...resultado.diasAjuste.domingoNoche },
      };
      evangelismo = resultado.evangelismo;
      estado = 'ok';
    } catch (err) {
      console.error('Falló el análisis con IA:', err.message);
      estado = 'sin_saldo';
      dias = diasClima;
    }
  }

  if (!evangelismo) {
    const mejorSinIA = clima.filter((_, i) => i !== 2).sort((a, b) => a.probLluvia - b.probLluvia)[0];
    evangelismo = {
      mejorDia: mejorSinIA.fecha,
      motivo: 'Estimación solo por clima: el día con menor probabilidad de lluvia esta semana.',
      zonas: ZONAS_FALLBACK,
    };
  }

  await db.collection('pronostico').doc('semanal').set({
    generadoEn: new Date().toISOString().split('T')[0],
    estado,
    dias,
    evangelismo,
  });

  console.log('Pronóstico semanal guardado. Estado:', estado);
}

async function generarMensual(db) {
  const apiKey = process.env.GEMINI_API_KEY;
  const ahora = new Date();
  const mesNombre = ahora.toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: TIMEZONE });

  if (!apiKey) {
    await db.collection('pronostico').doc('mensual').set({
      generadoEn: new Date().toISOString().split('T')[0],
      estado: 'pendiente',
      mes: mesNombre,
      resumen: '',
      eventosDestacados: [],
      mejoresDiasEvangelismo: [],
    });
    console.log('Pronóstico mensual: sin GEMINI_API_KEY, queda pendiente.');
    return;
  }

  let estado = 'ok';
  let datos = { resumen: '', eventosDestacados: [], mejoresDiasEvangelismo: [] };

  try {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    const prompt = `Sos un asistente que ayuda a una iglesia evangélica ("Casa De Dios") en Tres Arroyos, Argentina, a planificar el mes de evangelismo callejero.
Buscá noticias, feriados y eventos locales de Tres Arroyos para ${mesNombre}.
Escribí un resumen breve (2 a 3 frases) sobre el pronóstico general del mes y qué se puede esperar para salir a evangelizar en la calle.
Listá los eventos locales destacados que encuentres (nombre y fecha aproximada).
Sugerí entre 3 y 5 fechas específicas de ese mes (excluyendo domingos) que parezcan buenas para salir a evangelizar en lugares públicos, con un motivo breve cada una.`;
    const schema = {
      type: 'object',
      properties: {
        resumen: { type: 'string' },
        eventosDestacados: {
          type: 'array',
          items: {
            type: 'object',
            properties: { nombre: { type: 'string' }, fecha: { type: 'string' } },
            required: ['nombre', 'fecha'],
            additionalProperties: false,
          },
        },
        mejoresDiasEvangelismo: {
          type: 'array',
          items: {
            type: 'object',
            properties: { fecha: { type: 'string' }, motivo: { type: 'string' } },
            required: ['fecha', 'motivo'],
            additionalProperties: false,
          },
        },
      },
      required: ['resumen', 'eventosDestacados', 'mejoresDiasEvangelismo'],
      additionalProperties: false,
    };
    datos = await generarConIA(ai, prompt, schema);
  } catch (err) {
    console.error('Falló el análisis mensual con IA:', err.message);
    estado = 'sin_saldo';
  }

  await db.collection('pronostico').doc('mensual').set({
    generadoEn: new Date().toISOString().split('T')[0],
    estado,
    mes: mesNombre,
    ...datos,
  });

  console.log('Pronóstico mensual guardado. Estado:', estado);
}

// Si la fecha cae dentro de los próximos ~16 días, Open-Meteo puede darnos un
// pronóstico real; si es más lejana (cualquier mes del año), no hay pronóstico
// de clima posible y la IA se apoya solo en su conocimiento estacional/de noticias.
async function obtenerClimaParaFecha(fechaISO) {
  const hoy = new Date();
  const objetivo = new Date(fechaISO + 'T00:00:00');
  const diffDias = Math.round((objetivo - hoy) / (1000 * 60 * 60 * 24));
  if (diffDias < 0 || diffDias > 15) return null;

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${TRES_ARROYOS.lat}&longitude=${TRES_ARROYOS.lng}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=${encodeURIComponent(TIMEZONE)}&forecast_days=16`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const d = data.daily;
  const idx = d.time.indexOf(fechaISO);
  if (idx === -1) return null;
  return {
    descripcion: WMO[d.weather_code[idx]] || 'Clima variable',
    tempMax: d.temperature_2m_max[idx],
    probLluvia: d.precipitation_probability_max[idx],
  };
}

async function generarEventos(db) {
  const apiKey = process.env.GEMINI_API_KEY;
  // Reintenta también los que fallaron antes (probablemente por límite de cuota gratuita),
  // no solo los recién creados.
  const snap = await db.collection('eventosEvangelismo').where('estado', 'in', ['pendiente', 'sin_saldo']).get();
  if (snap.empty) {
    console.log('No hay eventos de evangelismo pendientes de analizar.');
    return;
  }
  if (!apiKey) {
    console.log(`Hay ${snap.size} evento(s) pendiente(s), pero falta GEMINI_API_KEY. Quedan sin analizar por ahora.`);
    return;
  }

  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });

  const schema = {
    type: 'object',
    properties: {
      expectativa: { type: 'string', enum: ['alta', 'media', 'baja'] },
      mensaje: { type: 'string' },
    },
    required: ['expectativa', 'mensaje'],
    additionalProperties: false,
  };

  for (const doc of snap.docs) {
    const ev = doc.data();
    try {
      const clima = await obtenerClimaParaFecha(ev.fechaInicio);
      const contextoClima = clima
        ? `Pronóstico del clima disponible para el ${ev.fechaInicio}: ${clima.descripcion}, ${Math.round(clima.tempMax)}°C, ${clima.probLluvia}% de probabilidad de lluvia.`
        : `La fecha está fuera del rango de pronóstico del clima (más de 16 días); basate en el conocimiento estacional típico de esa época del año en Tres Arroyos, Argentina.`;
      const prompt = `Sos un asistente que ayuda a una iglesia evangélica ("Casa De Dios") en Tres Arroyos, Argentina, a evaluar una campaña o evento de evangelismo público.
Evento: "${ev.titulo}"
Lugar: ${ev.lugar || 'no especificado'}
Fechas: del ${ev.fechaInicio} al ${ev.fechaFin || ev.fechaInicio}
${contextoClima}

Buscá noticias locales de Tres Arroyos, el contexto estacional para esas fechas, feriados, otros eventos que puedan competir o sumar público, y cualquier información relevante sobre "${ev.lugar}" si es un predio o lugar conocido de la ciudad (por ejemplo, si coincide con una fiesta o feria tradicional del lugar).
Con toda esa información, evaluá la expectativa de asistencia para este evento (alta, media o baja) y escribí un mensaje breve (3 a 4 frases) explicando tu análisis y, si corresponde, alguna recomendación práctica.`;

      const analisis = await generarConIA(ai, prompt, schema);
      await doc.ref.update({ estado: 'analizado', analisis: { ...analisis, generadoEn: new Date().toISOString().split('T')[0] } });
      console.log(`Evento "${ev.titulo}" analizado: ${analisis.expectativa}`);
    } catch (err) {
      console.error(`Falló el análisis del evento "${ev.titulo}":`, err.message);
      await doc.ref.update({ estado: 'sin_saldo' }).catch(() => {});
    }
  }
}

async function main() {
  const modo = process.argv[2];
  if (modo !== 'semanal' && modo !== 'mensual' && modo !== 'eventos') {
    console.error('Uso: node pronostico.mjs <semanal|mensual|eventos>');
    process.exit(1);
  }
  const db = initFirebase();
  if (modo === 'semanal') await generarSemanal(db);
  else if (modo === 'mensual') await generarMensual(db);
  else await generarEventos(db);
}

main().catch((err) => {
  console.error('Error generando el pronóstico:', err);
  process.exit(1);
});
