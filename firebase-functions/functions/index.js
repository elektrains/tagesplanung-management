const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const { defineSecret } = require('firebase-functions/params');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const admin = require('firebase-admin');
const tagesplan = require('./tagesplan');

admin.initializeApp({
  databaseURL: 'https://elektra-tagesplanung-23b62-default-rtdb.europe-west1.firebasedatabase.app'
});

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    docType: { type: 'string', enum: ['aufgebot', 'maengelliste', 'rechnung', 'unbekannt'] },
    name: { type: 'string' },
    vorname: { type: 'string' },
    plz: { type: 'string' },
    objektadresse: { type: 'string' },
    objektplz: { type: 'string' },
    versendetAn: { type: 'string' },
    erhaltenAm: { type: ['string', 'null'], description: 'ISO-Datum YYYY-MM-DD oder null' },
    frist: { type: ['string', 'null'], description: 'ISO-Datum YYYY-MM-DD oder null' },
    maengellisteErhaltenAm: { type: ['string', 'null'], description: 'ISO-Datum YYYY-MM-DD oder null' },
    bemerkungen: { type: 'string' }
  },
  required: ['docType', 'name', 'vorname', 'plz', 'objektadresse', 'objektplz', 'versendetAn', 'erhaltenAm', 'frist', 'maengellisteErhaltenAm', 'bemerkungen'],
  additionalProperties: false
};

const EXTRACTION_PROMPT = `Du bekommst ein Dokument einer periodischen Elektro-Kontrolle (PK) einer Schweizer Elektrofirma. Es kann ein Aufgebot/eine Kontrollaufforderung, eine Mängelliste oder eine Rechnung eines Kontrollorgans sein (z.B. Swisselko, electrocontrol, energiecheck, ET Swiss).

Extrahiere die Felder aus dem Dokument. Wenn ein Feld nicht im Dokument vorkommt, setze Strings auf "" und Datumsfelder auf null. Daten immer als YYYY-MM-DD.`;

exports.extractKontrolle = onCall({ secrets: [ANTHROPIC_API_KEY], cors: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login erforderlich.');
  }
  const { base64, mimeType } = request.data || {};
  if (!base64 || !mimeType) {
    throw new HttpsError('invalid-argument', 'Datei fehlt.');
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

  const docBlock = mimeType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } };

  let response;
  try {
    response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      output_config: { format: { type: 'json_schema', schema: EXTRACTION_SCHEMA } },
      messages: [{
        role: 'user',
        content: [docBlock, { type: 'text', text: EXTRACTION_PROMPT }]
      }]
    });
  } catch (e) {
    throw new HttpsError('internal', 'KI-Fehler: ' + e.message);
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    throw new HttpsError('internal', 'Keine Antwort von der KI erhalten.');
  }
  try {
    return JSON.parse(textBlock.text);
  } catch (e) {
    throw new HttpsError('internal', 'Ungültige Antwort von der KI.');
  }
});

// ===== KALENDER-SYNC =====
// Liest die für das Dienstkonto freigegebenen Mitarbeiterkalender und liefert pro Tag
// und Mitarbeiter den Status (Ferien/Schule/Halbtags) sowie die Einsätze zurück.
// Schreibt bewusst nichts in die Datenbank — was davon in der Tagesplanung landet,
// entscheidet der Benutzer im Browser.

const KALENDER_SA = 'kalender-sync@elektra-tagesplanung-23b62.iam.gserviceaccount.com';
const KALENDER_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const ZEITZONE = 'Europe/Zurich';

const TAG_FMT = new Intl.DateTimeFormat('sv-SE', { timeZone: ZEITZONE });
const ZEIT_FMT = new Intl.DateTimeFormat('de-CH', { timeZone: ZEITZONE, hour: '2-digit', minute: '2-digit', hour12: false });

// Verträgt sowohl "…+02:00" als auch "…Z" — zwei Kalender laufen auf UTC statt Europe/Zurich
function tagesKey(iso) { return TAG_FMT.format(new Date(iso)); }
function uhrzeit(iso) { return ZEIT_FMT.format(new Date(iso)); }
function lokaleStunde(iso) {
  const [h, m] = uhrzeit(iso).split(':').map(Number);
  return h + m / 60;
}

// Ganztägige Einträge laufen von start.date bis end.date EXKLUSIV
function ganztagsTage(startDate, endDate) {
  const tage = [];
  const d = new Date(startDate + 'T00:00:00Z');
  const bis = new Date(endDate + 'T00:00:00Z');
  while (d < bis && tage.length < 400) {
    tage.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return tage;
}

// Abwesenheiten sind ganztägig UND als "frei" markiert (transparency), Einsätze nie.
function klassifiziere(ev) {
  const ganztags = !!(ev.start && ev.start.date);
  const alsFreiMarkiert = ev.transparency === 'transparent';
  if (ganztags && alsFreiMarkiert) {
    const t = (ev.summary || '').toLowerCase();
    if (/schule|berufsschule|\bkurs\b|ük|uek|bbz/.test(t)) return { art: 'status', status: 'school' };
    if (/nachmittag\s*frei|nm\s*frei/.test(t)) return { art: 'status', status: 'half', haelfte: 'X1' };
    if (/vormittag\s*frei|morgen\s*frei|vm\s*frei/.test(t)) return { art: 'status', status: 'half', haelfte: 'X2' };
    return { art: 'status', status: 'absent' };
  }
  if (ganztags) return { art: 'ignorieren' };
  return { art: 'einsatz' };
}

// Liest die Kalender im Zeitraum und liefert je Tag und Mitarbeiter Status und Einsätze.
async function kalenderLesen(kalender, von, bis) {
  // Grosszügiger Rand, damit die Sommerzeit-Umstellung keine Rolle spielt —
  // exakt gefiltert wird danach über den Zürcher Tagesschlüssel.
  const timeMin = new Date(von + 'T00:00:00Z');
  timeMin.setUTCDate(timeMin.getUTCDate() - 1);
  const timeMax = new Date(bis + 'T00:00:00Z');
  timeMax.setUTCDate(timeMax.getUTCDate() + 2);

  const auth = new google.auth.GoogleAuth({ scopes: [KALENDER_SCOPE] });
  const cal = google.calendar({ version: 'v3', auth: await auth.getClient() });

  const tage = {};
  const fehler = [];
  const eintrag = (tag, mitarbeiter) => {
    if (tag < von || tag > bis) return null;
    if (!tage[tag]) tage[tag] = {};
    if (!tage[tag][mitarbeiter]) tage[tag][mitarbeiter] = { status: null, haelfte: null, einsaetze: [] };
    return tage[tag][mitarbeiter];
  };

  for (const [mitarbeiter, calendarId] of Object.entries(kalender)) {
    if (!calendarId) continue;
    let items;
    try {
      const res = await cal.events.list({
        calendarId,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250
      });
      items = res.data.items || [];
    } catch (e) {
      const code = e && e.code;
      fehler.push({
        mitarbeiter,
        meldung: code === 404 ? 'Kalender nicht gefunden — ID prüfen.'
          : code === 403 ? 'Kein Zugriff — Freigabe für das Dienstkonto fehlt.'
            : (e.message || 'Unbekannter Fehler')
      });
      continue;
    }

    for (const ev of items) {
      if (ev.status === 'cancelled') continue;
      const k = klassifiziere(ev);
      if (k.art === 'ignorieren') continue;

      if (k.art === 'status') {
        for (const tag of ganztagsTage(ev.start.date, ev.end.date)) {
          const e = eintrag(tag, mitarbeiter);
          if (!e) continue;
          // Schule/Halbtags sind spezifischer als ein blosses "abwesend"
          if (!e.status || k.status !== 'absent') e.status = k.status;
          if (k.haelfte) e.haelfte = k.haelfte;
        }
        continue;
      }

      const beginn = ev.start && ev.start.dateTime;
      if (!beginn) continue;
      // Feierabendtermine (Stützkurs, Besprechungen) sind keine Baustelle
      if (lokaleStunde(beginn) >= 16.5) continue;
      const e = eintrag(tagesKey(beginn), mitarbeiter);
      if (!e) continue;
      e.einsaetze.push({
        titel: (ev.summary || '').trim(),
        von: uhrzeit(beginn),
        bis: ev.end && ev.end.dateTime ? uhrzeit(ev.end.dateTime) : ''
      });
    }
  }

  return { tage, fehler };
}

// Tagesschlüssel eines Zeitraums, Wochenenden übersprungen
function tageImBereich(von, bis, mitWochenende) {
  const liste = [];
  const d = new Date(von + 'T00:00:00Z');
  const ende = new Date(bis + 'T00:00:00Z');
  while (d <= ende && liste.length < 120) {
    const wt = d.getUTCDay();
    if (mitWochenende || (wt !== 0 && wt !== 6)) liste.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return liste;
}

function planVon(plans, tag) {
  const p = plans[tag];
  return p ? JSON.parse(JSON.stringify(p)) : { sites: [], globalStatus: {} };
}

async function einstellungenUndPlaene() {
  const db = admin.database();
  const [sSnap, pSnap] = await Promise.all([db.ref('settings').get(), db.ref('plans').get()]);
  const settings = sSnap.val() || {};
  return {
    plans: pSnap.val() || {},
    employees: settings.employees || [],
    statusOnly: settings.kalenderStatusOnly || [],
    kalender: settings.kalender || {}
  };
}

// Liefert je Tag die fertigen Vorschläge. Schreibt nichts.
exports.syncKalender = onCall({ cors: true, serviceAccount: KALENDER_SA, timeoutSeconds: 180 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login erforderlich.');
  const { von, bis } = request.data || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(von || '') || !/^\d{4}-\d{2}-\d{2}$/.test(bis || '')) {
    throw new HttpsError('invalid-argument', 'Zeitraum fehlt oder ist ungültig.');
  }

  const cfg = await einstellungenUndPlaene();
  if (!Object.keys(cfg.kalender).length) {
    throw new HttpsError('failed-precondition', 'Keine Kalender zugeordnet. Bitte zuerst in den Einstellungen eintragen.');
  }

  const roh = await kalenderLesen(cfg.kalender, von, bis);
  const tage = {};
  tageImBereich(von, bis, true).forEach((tag) => {
    const vorschlaege = tagesplan.vorschlaegeBauen({
      tagesDaten: roh.tage[tag] || {},
      plan: planVon(cfg.plans, tag),
      employees: cfg.employees,
      statusOnly: cfg.statusOnly,
      plans: cfg.plans
    });
    tage[tag] = { vorschlaege };
  });
  return { tage, fehler: roh.fehler };
});

// Übernimmt die vom Benutzer angehakten Vorschläge in einen Tag.
exports.uebernehmeVorschlaege = onCall({ cors: true, serviceAccount: KALENDER_SA, timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login erforderlich.');
  const { datum, vorschlaege } = request.data || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum || '')) throw new HttpsError('invalid-argument', 'Datum fehlt.');
  if (!Array.isArray(vorschlaege) || !vorschlaege.length) return { uebernommen: 0 };

  const cfg = await einstellungenUndPlaene();
  const erlaubt = new Set(['X', 'X1', 'X2']);
  const gueltig = vorschlaege.filter((v) => {
    if (!v || (v.typ !== 'status' && v.typ !== 'einsatz')) return false;
    if (v.typ === 'status') return cfg.employees.indexOf(v.emp) >= 0 && ['absent', 'school', 'half', ''].indexOf(v.wert) >= 0;
    return Object.keys(v.zuteilung || {}).every((e) => cfg.employees.indexOf(e) >= 0 && erlaubt.has(v.zuteilung[e]));
  });
  if (!gueltig.length) throw new HttpsError('invalid-argument', 'Keine gültigen Vorschläge.');

  const plan = planVon(cfg.plans, datum);
  gueltig.forEach((v) => tagesplan.vorschlagAnwenden(v, plan));
  tagesplan.eigeneZeilenErgaenzen(plan, cfg.employees, cfg.plans);
  tagesplan.sortiereZeilen(plan, cfg.employees, cfg.plans);
  await admin.database().ref('plans/' + datum).set(plan);
  return { uebernommen: gueltig.length };
});

// Füllt nachts die Tage, die noch völlig leer sind. Angefasste Tage bleiben unberührt.
exports.nachtlaufKalender = onSchedule({
  schedule: '0 4 * * *', timeZone: ZEITZONE, serviceAccount: KALENDER_SA, timeoutSeconds: 540
}, async () => {
  const cfg = await einstellungenUndPlaene();
  if (!Object.keys(cfg.kalender).length) {
    logger.info('Nachtlauf übersprungen: keine Kalender zugeordnet.');
    return;
  }
  const heute = TAG_FMT.format(new Date());
  const b = new Date(heute + 'T00:00:00Z');
  b.setUTCDate(b.getUTCDate() + 13);
  const bis = b.toISOString().slice(0, 10);

  const roh = await kalenderLesen(cfg.kalender, heute, bis);
  const db = admin.database();
  const gefuellt = [];
  for (const tag of tageImBereich(heute, bis, false)) {
    const plan = planVon(cfg.plans, tag);
    if (!tagesplan.istLeer(plan)) continue;
    const vorschlaege = tagesplan.vorschlaegeBauen({
      tagesDaten: roh.tage[tag] || {},
      plan,
      employees: cfg.employees,
      statusOnly: cfg.statusOnly,
      plans: cfg.plans
    });
    if (!vorschlaege.length) continue;
    vorschlaege.forEach((v) => tagesplan.vorschlagAnwenden(v, plan));
    tagesplan.eigeneZeilenErgaenzen(plan, cfg.employees, cfg.plans);
    tagesplan.sortiereZeilen(plan, cfg.employees, cfg.plans);
    await db.ref('plans/' + tag).set(plan);
    gefuellt.push(tag + ' (' + vorschlaege.length + ')');
  }
  logger.info('Nachtlauf fertig. Gefüllt: ' + (gefuellt.join(', ') || 'nichts') +
    (roh.fehler.length ? ' | Nicht gelesen: ' + roh.fehler.map((f) => f.mitarbeiter).join(', ') : ''));
});
