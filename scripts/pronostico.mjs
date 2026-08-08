// Genera el pronóstico de asistencia y evangelismo de Casa De Dios.
// Se ejecuta automáticamente vía GitHub Actions (ver .github/workflows/pronostico.yml):
//   - Todos los viernes a la mañana: `node pronostico.mjs semanal`
//   - El día 1 de cada mes:          `node pronostico.mjs mensual`
//
// Usa Open-Meteo (gratis, sin clave) para el clima y, si hay saldo configurado,
// la API de Anthropic (con búsqueda web) para sugerir el mejor día/zonas de
// evangelismo y el resumen mensual. Si falta ANTHROPIC_API_KEY o falla por
// falta de saldo, el documento se guarda igual con la parte de clima y un
// estado que la app muestra como aviso, sin romper nada.

import admin from 'firebase-admin';

const TRES_ARROYOS = { lat: -38.3739, lng: -60.2761 };
const TIMEZONE = 'America/Argentina/Buenos_Aires';
const BASES = { viernes: 40, sabado: 60, domingoManana: 250, domingoNoche: 250 };

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

function factorClima(probLluvia) {
  if (probLluvia >= 60) return 0.75;
  if (probLluvia >= 30) return 0.9;
  if (probLluvia <= 5) return 1.05;
  return 1.0;
}

function motivoClima(probLluvia) {
  if (probLluvia >= 60) return 'Alta probabilidad de lluvia, puede bajar la asistencia';
  if (probLluvia >= 30) return 'Chance de lluvia, leve ajuste a la baja';
  if (probLluvia <= 5) return 'Buen clima, sin lluvia a la vista';
  return 'Clima estable, similar a un día normal';
}

function calcularDiaEstimado(base, clima) {
  const factor = factorClima(clima.probLluvia);
  return {
    estimado: Math.round(base * factor),
    clima: { descripcion: clima.descripcion, tempMax: clima.tempMax, probLluvia: clima.probLluvia },
    motivo: motivoClima(clima.probLluvia),
  };
}

async function generarConIA(anthropic, model, prompt, schema) {
  const response = await anthropic.messages.create({
    model,
    max_tokens: 2048,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: prompt }],
  });
  if (response.stop_reason === 'refusal') throw new Error('La IA rechazó la consulta');
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('La IA no devolvió una respuesta de texto');
  return JSON.parse(textBlock.text);
}

async function generarSemanal(db) {
  const clima = await obtenerClimaSemana();
  const [climaViernes, climaSabado, climaDomingo] = clima;

  const dias = {
    viernes: calcularDiaEstimado(BASES.viernes, climaViernes),
    sabado: calcularDiaEstimado(BASES.sabado, climaSabado),
    domingoManana: calcularDiaEstimado(BASES.domingoManana, climaDomingo),
    domingoNoche: calcularDiaEstimado(BASES.domingoNoche, climaDomingo),
  };

  let evangelismo = null;
  let estado = 'pendiente';
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (apiKey) {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const anthropic = new Anthropic({ apiKey });
      const candidatos = clima.filter((_, i) => i !== 2).map((c) => c.fecha); // toda la semana menos el domingo
      const prompt = `Sos un asistente que ayuda a una iglesia evangélica ("Casa De Dios") en Tres Arroyos, Argentina, a planificar salidas de evangelismo callejero.
Buscá noticias y eventos locales recientes de Tres Arroyos para la semana del ${clima[0].fecha} al ${clima[6].fecha} (ferias, fiestas patronales, eventos deportivos, clima).
Con esa información, elegí UNA fecha de esta lista como la mejor para salir a evangelizar en lugares PÚBLICOS: ${candidatos.join(', ')}.
Sugerí también 2 o 3 zonas públicas reales de Tres Arroyos (plazas, veredas céntricas, parques, costanera — NUNCA lugares privados como canchas de fútbol privadas o clubes) con el horario aproximado de mayor circulación de gente y sus coordenadas geográficas aproximadas (latitud/longitud).
Si no encontrás noticias específicas de esa semana, basate en el conocimiento general de la ciudad, el calendario y el clima. No inventes eventos que no existan.`;
      const schema = {
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
      };
      evangelismo = await generarConIA(anthropic, 'claude-sonnet-5', prompt, schema);
      estado = 'ok';
    } catch (err) {
      console.error('Falló el análisis con IA:', err.message);
      estado = 'sin_saldo';
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
  const apiKey = process.env.ANTHROPIC_API_KEY;
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
    console.log('Pronóstico mensual: sin ANTHROPIC_API_KEY, queda pendiente.');
    return;
  }

  let estado = 'ok';
  let datos = { resumen: '', eventosDestacados: [], mejoresDiasEvangelismo: [] };

  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey });
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
    datos = await generarConIA(anthropic, 'claude-sonnet-5', prompt, schema);
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

async function main() {
  const modo = process.argv[2];
  if (modo !== 'semanal' && modo !== 'mensual') {
    console.error('Uso: node pronostico.mjs <semanal|mensual>');
    process.exit(1);
  }
  const db = initFirebase();
  if (modo === 'semanal') await generarSemanal(db);
  else await generarMensual(db);
}

main().catch((err) => {
  console.error('Error generando el pronóstico:', err);
  process.exit(1);
});
