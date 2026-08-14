// Ableitung der Tagesplanung aus Kalenderdaten.
// Liegt bewusst hier und nicht im Browser: Knöpfe und Nachtlauf müssen dasselbe tun.

const STOPP = new Set(['und', 'mit', 'der', 'die', 'das', 'den', 'dem', 'ins', 'in', 'im', 'am', 'an',
  'auf', 'bei', 'für', 'von', 'vom', 'zum', 'zur', 'neue', 'neuer', 'neues', 'div', 'diverse', 'std', 'ca',
  'herr', 'frau']);

// Hat keinen Kalender und ist nie auf einer Baustelle
const IMMER_ABWESEND = ['Schnuppi'];

function tokens(s) {
  return String(s || '').toLowerCase().replace(/[.,;:/()[\]{}"'`–—+-]+/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPP.has(w));
}

// sites kann in der Datenbank Array oder Objekt sein
function sitesArr(plan) {
  const s = (plan || {}).sites;
  if (!s) return [];
  return Array.isArray(s) ? s.filter(Boolean) : Object.keys(s).map((k) => s[k]).filter(Boolean);
}

// Nur Tage mit echtem Inhalt – sonst verdrängen leere Tage die Historie
function planTage(plans) {
  return Object.keys(plans || {}).filter((k) => sitesArr(plans[k]).length).sort();
}

function bekannteBaustellen(plans) {
  const zaehler = {};
  planTage(plans).slice(-60).forEach((k) => {
    sitesArr(plans[k]).forEach((s) => {
      const n = String(s.name || '').trim();
      if (n) zaehler[n] = (zaehler[n] || 0) + 1;
    });
  });
  return Object.keys(zaehler).sort((a, b) => zaehler[b] - zaehler[a]);
}

// "Apparatemontage und Leuchten Traube" -> "Traube", "St. Johannsen - GSA" -> "St. Johannsen"
function baustelleAusTitel(titel, bekannt) {
  const tk = new Set(tokens(titel));
  let best = null; let bestTreffer = 0; let bestScore = 0;
  (bekannt || []).forEach((name) => {
    const nk = tokens(name);
    if (!nk.length || !tk.size) return;
    const treffer = nk.filter((w) => tk.has(w)).length;
    if (!treffer) return;
    const score = treffer / Math.min(nk.length, tk.size);
    if (score > bestScore || (score === bestScore && treffer > bestTreffer)) {
      bestScore = score; bestTreffer = treffer; best = name;
    }
  });
  if (best && bestScore >= 0.6) return best;
  const vorDemStrich = String(titel || '').split(/\s[–—-]\s/)[0].trim();
  return vorDemStrich || String(titel || '').trim();
}

function stammFahrzeug(plans, emp) {
  const zaehler = {};
  planTage(plans).slice(-40).forEach((k) => {
    sitesArr(plans[k]).forEach((s) => {
      if (s.vehicle && (s.assignments || {})[emp]) zaehler[s.vehicle] = (zaehler[s.vehicle] || 0) + 1;
    });
  });
  const beste = Object.keys(zaehler).sort((a, b) => zaehler[b] - zaehler[a])[0];
  return beste ? Number(beste) : null;
}

function empRang(employees, emp) {
  const i = (employees || []).indexOf(emp);
  return i < 0 ? 9998 : i;
}

function fahrzeugBesitzer(plans, employees) {
  const m = {};
  (employees || []).forEach((e) => {
    const fz = stammFahrzeug(plans, e);
    if (fz !== null && m[fz] === undefined) m[fz] = empRang(employees, e);
  });
  return m;
}

const STATUS_TEXT = { absent: 'Abwesend', school: 'Schule', half: 'Halbtags', '': 'Anwesend' };

function vorschlaegeBauen(opt) {
  const tagesDaten = opt.tagesDaten || {};
  const plan = opt.plan || {};
  const employees = opt.employees || [];
  const statusOnly = opt.statusOnly || [];
  const plans = opt.plans || {};
  const bekannt = bekannteBaustellen(plans);
  const sites = sitesArr(plan);
  const v = [];
  const gruppen = {};

  Object.keys(tagesDaten).forEach((emp) => {
    const d = tagesDaten[emp] || {};
    const jetzt = (plan.globalStatus || {})[emp] || '';
    if (d.status && d.status !== jetzt) {
      v.push({
        typ: 'status', emp, wert: d.status, rang: empRang(employees, emp),
        text: emp + ' → ' + STATUS_TEXT[d.status] + ' (bisher ' + (STATUS_TEXT[jetzt] || jetzt) + ')'
      });
    }
    if (statusOnly.indexOf(emp) >= 0) return;
    if (!d.einsaetze || !d.einsaetze.length) return;
    let namen = [];
    d.einsaetze.forEach((e) => {
      const n = baustelleAusTitel(e.titel, bekannt);
      if (n && namen.indexOf(n) < 0) namen.push(n);
    });
    // "Tertianum" neben "Tertianum/Schulhaus Gampelen" – der längere Name gewinnt
    namen = namen.filter((a) => !namen.some((b) => b !== a && b.toLowerCase().indexOf(a.toLowerCase()) >= 0));
    if (!namen.length) return;
    // Dieselbe Baustelle ergibt EINE Zeile mit mehreren X, nicht eine Zeile pro Mann
    const name = namen.join('/');
    if (!gruppen[name]) gruppen[name] = {};
    gruppen[name][emp] = d.haelfte || 'X';
  });

  Object.keys(gruppen).forEach((name) => {
    const zuteilung = gruppen[name];
    const emps = Object.keys(zuteilung).sort((a, b) => empRang(employees, a) - empRang(employees, b));
    const gleich = (s) => String(s.name || '').trim().toLowerCase() === name.toLowerCase();
    // 1. Zeile mit diesem Namen  2. Zeile, auf der der Monteur schon steht  3. sein Stammfahrzeug
    let idx = sites.findIndex(gleich);
    if (idx < 0) idx = sites.findIndex((s) => emps.some((e) => (s.assignments || {})[e]));
    const fahrzeug = stammFahrzeug(plans, emps[0]);
    if (idx < 0 && fahrzeug !== null) idx = sites.findIndex((s) => s.vehicle === fahrzeug && !String(s.name || '').trim());
    if (idx >= 0 && gleich(sites[idx]) && emps.every((e) => (sites[idx].assignments || {})[e] === zuteilung[e])) return;
    const alterName = idx >= 0 ? String(sites[idx].name || '').trim() : '';
    const zusatz = idx < 0 ? ' — neue Zeile'
      : (alterName && alterName.toLowerCase() !== name.toLowerCase() ? ' (statt „' + alterName + '“)' : '');
    const wer = emps.map((e) => e + (zuteilung[e] !== 'X' ? ' [' + zuteilung[e] + ']' : '')).join(', ');
    v.push({
      typ: 'einsatz', name, zuteilung, siteIdx: idx < 0 ? null : idx, fahrzeug,
      rang: empRang(employees, emps[0]), text: wer + ' → ' + name + zusatz
    });
  });

  IMMER_ABWESEND.forEach((emp) => {
    if (employees.indexOf(emp) < 0) return;
    if (((plan.globalStatus || {})[emp] || '') === 'absent') return;
    v.push({ typ: 'status', emp, wert: 'absent', rang: empRang(employees, emp), text: emp + ' → Abwesend' });
  });

  v.sort((a, b) => a.rang - b.rang);
  return v;
}

function vorschlagAnwenden(v, plan) {
  if (v.typ === 'status') {
    if (!plan.globalStatus) plan.globalStatus = {};
    plan.globalStatus[v.emp] = v.wert;
    return;
  }
  if (!Array.isArray(plan.sites)) plan.sites = sitesArr(plan);
  let site = v.siteIdx !== null && v.siteIdx !== undefined ? plan.sites[v.siteIdx] : null;
  if (!site) {
    site = { id: 's' + Date.now() + Math.random(), name: '', vehicle: v.fahrzeug || null, assignments: {} };
    plan.sites.push(site);
  }
  site.name = v.name;
  if (!site.assignments) site.assignments = {};
  Object.keys(v.zuteilung || {}).forEach((e) => { site.assignments[e] = v.zuteilung[e]; });
}

// Jeder mit eigenem Fahrzeug bekommt seine eigene Zeile – auch wenn er heute bei
// jemand anderem mitfährt. Sie bleibt dann namenlos und ist schnell umzudisponieren.
function eigeneZeilenErgaenzen(plan, employees, plans) {
  if (!Array.isArray(plan.sites)) plan.sites = sitesArr(plan);
  (employees || []).forEach((emp) => {
    const fz = stammFahrzeug(plans, emp);
    if (fz === null) return;
    if (plan.sites.some((s) => s.vehicle === fz)) return;
    plan.sites.push({ id: 's' + Date.now() + Math.random(), name: '', vehicle: fz, assignments: {} });
  });
}

// Zeilen so ordnen, dass die X von links nach rechts treppenartig nach unten laufen
function sortiereZeilen(plan, employees, plans) {
  const besitzer = fahrzeugBesitzer(plans, employees);
  const rang = (s) => {
    const zu = s.assignments || {};
    const emps = Object.keys(zu).filter((e) => zu[e]);
    if (emps.length) return Math.min.apply(null, emps.map((e) => empRang(employees, e)));
    if (s.vehicle !== null && s.vehicle !== undefined && besitzer[s.vehicle] !== undefined) return besitzer[s.vehicle];
    return 9999;
  };
  plan.sites = sitesArr(plan).map((s, i) => ({ s, i, r: rang(s) }))
    .sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.s);
}

// "Leer" heisst: keine Baustelle benannt, niemand eingeteilt, kein Status gesetzt.
// Ein angewendetes Vorlagen-Gerüst aus leeren Fahrzeugzeilen zählt also noch als leer.
function istLeer(plan) {
  if (!plan) return true;
  const gs = plan.globalStatus || {};
  if (Object.keys(gs).some((k) => gs[k])) return false;
  return !sitesArr(plan).some((s) => String(s.name || '').trim() || Object.keys(s.assignments || {}).length);
}

module.exports = {
  tokens, sitesArr, planTage, bekannteBaustellen, baustelleAusTitel, stammFahrzeug,
  empRang, fahrzeugBesitzer, vorschlaegeBauen, vorschlagAnwenden, eigeneZeilenErgaenzen,
  sortiereZeilen, istLeer, STATUS_TEXT, IMMER_ABWESEND
};
