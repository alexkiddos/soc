'use strict';
const APP_VERSION = 'v5-universel';
const $ = (id) => document.getElementById(id);

/* ---------------- Journal & UI de base ---------------- */
function log(line) {
  const el = $('log');
  el.textContent += `[${new Date().toLocaleTimeString('fr-FR')}] ${line}\n`;
  if (el.textContent.length > 30000) el.textContent = el.textContent.slice(-20000);
  el.scrollTop = el.scrollHeight;
}
function setStatus(t, cls) { $('statusText').textContent = t; $('dot').className = cls || ''; }
function showMsg(t, info) { const m = $('msg'); m.textContent = t || ''; m.className = info ? 'info' : ''; m.style.display = t ? 'block' : 'none'; }
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
};
$('ver').textContent = APP_VERSION;
log('Version ' + APP_VERSION);

/* ---------------- Profils ---------------- */
// Normalise un profil ABRP (variantes de casse, tableaux ou {command:[…]})
function normalize(raw) {
  const get = (name) => { const k = Object.keys(raw).find((x) => x.toLowerCase() === name); return k ? raw[k] : undefined; };
  const list = (v) => (Array.isArray(v) ? v : v && Array.isArray(v.command) ? v.command : []);
  const init = list(get('init_commands')).map(String);
  const data = list(get('data_commands')).map(String);
  const pids = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || !v.equation || !v.command) continue;
    if (['init_commands', 'data_commands'].includes(k.toLowerCase())) continue;
    pids[k] = {
      equation: String(v.equation), command: String(v.command).toUpperCase().replace(/\s+/g, ''),
      ecu: v.ecu ? String(v.ecu) : '', type: v.type || 'Number',
      min: v.minValue !== undefined && v.minValue !== '' ? parseFloat(v.minValue) : null,
      max: v.maxValue !== undefined && v.maxValue !== '' ? parseFloat(v.maxValue) : null,
    };
  }
  if (!Object.keys(pids).length) throw new Error('aucune mesure avec « equation » et « command »');
  // commandes utilisées par une mesure mais absentes de data_commands : ajoutées à la fin
  const known = new Set(data.map((c) => c.toUpperCase().replace(/\s+/g, '')));
  for (const p of Object.values(pids)) if (!known.has(p.command)) { data.push(p.command); known.add(p.command); }
  return { init, data, pids };
}

let PROFILES = [];
let current = null; // {id, name, …, n: normalisé}

async function loadProfiles() {
  let builtin = [];
  try { builtin = await (await fetch('profiles.json')).json(); } catch (e) { log('profiles.json introuvable : ' + e.message); }
  const custom = store.get('customProfiles', []);
  PROFILES = [...custom.map((p) => ({ ...p, custom: true })), ...builtin];
  for (const p of PROFILES) { try { p.n = normalize(p.profile); } catch (e) { p.err = e.message; } }
  let id = store.get('profileId', null);
  if (!id && store.get('last', null)) id = 'fiat500e'; // migration depuis la version 500e
  selectProfile(PROFILES.find((p) => p.id === id && p.n) || null, false);
}

function selectProfile(p, reinit = true) {
  current = p;
  $('vehName').textContent = p ? p.name : 'Choisir un véhicule';
  store.set('profileId', p ? p.id : null);
  buildTiles();
  const last = p && store.get('last:' + p.id, null);
  resetGauge();
  if (last) render(last, true);
  if (reinit && p && elm.connected) initProfile().then(readAll);
}

/* ---------------- Tuiles ---------------- */
const KNOWN = {
  voltage: ['Tension pack', 'V', 1], current: ['Courant', 'A', 1], power: ['Puissance', 'kW', 1],
  batt_temp: ['Temp. batterie', '°C', 0], ext_temp: ['Temp. extérieure', '°C', 0], soh: ['SoH', '%', 1],
  soe: ['Énergie restante', 'kWh', 1], capacity: ['Capacité', 'kWh', 1], kwh_charged: ['kWh chargés (cumul)', 'kWh', 0],
  odometer: ['Odomètre', 'km', 0], speed: ['Vitesse', 'km/h', 0], vehicle_reported_speed: ['Vitesse', 'km/h', 0],
  is_charging: ['En charge', 'bool'], is_dcfc: ['Charge rapide DC', 'bool'], is_parked: ['Stationné', 'bool'],
  cells: ['Cellules min / max', 'V', 3], cdelta: ['Écart cellules', 'mV', 0], v12: ['Batterie 12 V', 'V', 2],
};
const CELL_MIN = /^_?(cell_min_voltage|bat_min_voltage)$/i, CELL_MAX = /^_?(cell_max_voltage|bat_max_voltage)$/i;

function tileKeys() {
  if (!current || !current.n) return [];
  const keys = Object.keys(current.n.pids).filter((k) => k !== 'soc');
  const hasCells = keys.some((k) => CELL_MIN.test(k)) && keys.some((k) => CELL_MAX.test(k));
  const order = Object.keys(KNOWN);
  let out = keys.filter((k) => !(hasCells && (CELL_MIN.test(k) || CELL_MAX.test(k))));
  if (!out.includes('power') && out.includes('voltage') && out.includes('current')) out.push('power');
  if (hasCells) out.push('cells', 'cdelta');
  out.push('v12');
  out.sort((a, b) => (order.includes(a) ? order.indexOf(a) : 99) - (order.includes(b) ? order.indexOf(b) : 99));
  return out;
}
function label(k) {
  if (KNOWN[k]) return KNOWN[k][0];
  return k.replace(/^_+/, '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
function buildTiles() {
  $('grid').innerHTML = tileKeys().map((k) => `<div class="tile" data-k="${k}"><div class="k">${label(k)}</div><div class="v">--</div></div>`).join('');
}
function fmt(k, v) {
  if (v == null || Number.isNaN(v)) return '--';
  const d = KNOWN[k];
  if (d && d[1] === 'bool') return v ? 'Oui' : 'Non';
  if (d) return `${v.toFixed(d[2])} ${d[1]}`;
  return Math.abs(v) >= 100 ? v.toFixed(0) : String(+v.toFixed(3));
}
function resetGauge() {
  $('soc').innerHTML = '--<small>%</small>'; $('updated').textContent = 'Aucune lecture'; setGauge(0);
}
function setGauge(pct) {
  const full = 405.3, p = Math.max(0, Math.min(100, pct || 0)), bar = $('bar');
  bar.style.strokeDashoffset = full - (full * p) / 100;
  bar.style.stroke = p < 15 ? 'var(--low)' : p < 30 ? 'var(--warn)' : 'var(--accent)';
}
function render(vals, stale) {
  if (vals.soc != null) { $('soc').innerHTML = `${vals.soc.toFixed(1)}<small>%</small>`; setGauge(vals.soc); }
  for (const t of document.querySelectorAll('#grid .tile')) {
    const k = t.dataset.k;
    let txt;
    if (k === 'cells') txt = vals.cmin == null ? '--' : `${vals.cmin.toFixed(3)} / ${vals.cmax.toFixed(3)} V`;
    else if (k === 'cdelta') txt = vals.cmin == null ? '--' : `${Math.round((vals.cmax - vals.cmin) * 1000)} mV`;
    else txt = fmt(k, vals[k]);
    t.querySelector('.v').textContent = txt;
    t.querySelector('.v').style.color = k === 'cdelta' && vals.cmin != null && vals.cmax - vals.cmin > 0.05 ? 'var(--warn)' : '';
    t.classList.toggle('stale', !!stale);
  }
  if (vals.ts) {
    const d = new Date(vals.ts);
    $('updated').textContent = (stale ? 'Dernière lecture ' : 'Lu à ') + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      + (Date.now() - vals.ts > 3600e3 ? ' le ' + d.toLocaleDateString('fr-FR') : '');
  }
}

/* ---------------- Lecture ---------------- */
const elm = new ELM.Elm(log);
let timer = null, reading = false, wakeLock = null;

async function initProfile() {
  if (!current) return;
  setStatus('Initialisation…', 'busy');
  const init = [...current.n.init];
  if (!init.some((c) => /^AT\s*(Z|D|WS)$/i.test(c))) init.unshift('ATD');
  if (!init.some((c) => /^AT\s*E0$/i.test(c))) init.splice(1, 0, 'ATE0');
  for (const c of init) {
    try { await elm.send(c, /^AT\s*Z$/i.test(c) ? 6000 : 3000); } catch (e) { log(`(ignoré) ${e.message}`); }
  }
}

async function readAll() {
  if (!elm.connected || reading || !current) return;
  reading = true; $('btnRead').disabled = true; setStatus('Lecture…', 'busy');
  const { data: cmds, pids } = current.n;
  const responses = {};
  try {
    for (const c of cmds) {
      const cmd = c.toUpperCase().replace(/\s+/g, '');
      if (cmd.startsWith('AT')) { try { await elm.send(c, 3000); } catch (e) { log(e.message); } continue; }
      const users = Object.values(pids).filter((p) => p.command === cmd);
      if (!users.length) { await elm.query(c); continue; } // commande « de service » (ex. session)
      const st = { ...elm.state };
      try {
        const raw = await elm.send(c, 5000);
        responses[cmd] = { parsed: ELM.parseMessages(raw, cmd, st), st };
      } catch (e) { log(e.message); }
    }
    const vals = { ts: Date.now() };
    const fails = [];
    for (const [k, p] of Object.entries(pids)) {
      const r = responses[p.command];
      if (!r) { fails.push(k); continue; }
      const ex = ELM.extract(r.parsed, p.command, r.st, p.ecu);
      if (!ex.data) { fails.push(`${k} (${ex.why})`); continue; }
      try {
        let v = Formula.evaluate(p.equation, ex.data);
        if (!Number.isFinite(v)) throw new Error('résultat non numérique');
        if ((p.min != null && v < p.min) || (p.max != null && v > p.max)) { fails.push(`${k} hors plage (${+v.toFixed(3)})`); continue; }
        if (CELL_MIN.test(k)) vals.cmin = v; else if (CELL_MAX.test(k)) vals.cmax = v; else vals[k] = v;
      } catch (e) { fails.push(`${k} (${e.message})`); }
    }
    if (vals.cmin != null && vals.cmax != null && vals.cmin > vals.cmax) [vals.cmin, vals.cmax] = [vals.cmax, vals.cmin];
    if (vals.cmin == null || vals.cmax == null) { delete vals.cmin; delete vals.cmax; }
    if (vals.power == null && vals.voltage != null && vals.current != null) vals.power = (vals.voltage * vals.current) / 1000;
    try { const rv = await elm.send('ATRV', 2000); const m = rv.match(/(\d+(\.\d+)?)V/i); if (m) vals.v12 = parseFloat(m[1]); } catch (_) {}
    if (fails.length) log('Non lus : ' + fails.join(', '));

    const got = Object.keys(vals).filter((k) => !['ts', 'v12'].includes(k)).length;
    if (!got) {
      showMsg('Aucune donnée reçue. Vérifiez que la voiture est allumée (contact / READY) et que le bon véhicule est sélectionné. Le journal indique ce qui a échoué.');
      setStatus('Connecté (pas de données)', 'err');
    } else {
      showMsg(fails.length && vals.soc == null ? 'SoC non lu — voir le journal. Vous pouvez tester d\'autres formules dans le mode découverte.' : '');
      setStatus('Connecté', 'on');
      render(vals);
      store.set('last:' + current.id, vals);
    }
  } finally {
    reading = false; $('btnRead').disabled = !elm.connected;
  }
}

function schedule() {
  clearInterval(timer);
  const s = parseInt($('interval').value, 10);
  if (elm.connected && s > 0) timer = setInterval(readAll, s * 1000);
  store.set('interval', s);
}

/* ---------------- Connexion ---------------- */
$('btnConnect').addEventListener('click', async () => {
  showMsg('');
  if (elm.connected) { elm.disconnect(); return; }
  if (!navigator.bluetooth) {
    showMsg("Web Bluetooth indisponible dans ce navigateur. Utilisez Chrome ou Edge (Android, ordinateur). Sur iPhone : le navigateur « Bluefy ».");
    return;
  }
  if (!current) { openVeh(); showMsg('Choisissez d\'abord votre véhicule.', true); return; }
  try {
    setStatus('Connexion…', 'busy');
    await elm.connect();
    $('btnConnect').textContent = 'Déconnecter'; $('btnConnect').classList.add('secondary');
    $('dsend').disabled = false; $('btnVin').disabled = false;
    await initProfile();
    await readAll();
    schedule();
  } catch (e) {
    log('Erreur : ' + e.message);
    if (e.name !== 'NotFoundError') showMsg('Connexion impossible : ' + e.message);
    setStatus('Déconnecté', '');
    elm.disconnect();
  }
});
elm.onDisconnect = () => {
  clearInterval(timer);
  $('btnConnect').textContent = 'Connecter le dongle'; $('btnConnect').classList.remove('secondary');
  $('btnRead').disabled = true; $('dsend').disabled = true; $('btnVin').disabled = true;
  setStatus('Déconnecté', ''); log('Déconnecté');
};
$('btnRead').addEventListener('click', readAll);
$('interval').addEventListener('change', schedule);

/* ---------------- Choix du véhicule ---------------- */
let highlight = [];
function openVeh() { renderVehList(); $('vehDlg').showModal(); }
function renderVehList() {
  const q = $('vehSearch').value.trim().toLowerCase();
  const list = PROFILES.filter((p) => !q || (p.name + ' ' + (p.makes || []).join(' ')).toLowerCase().includes(q))
    .sort((a, b) => highlight.includes(b.id) - highlight.includes(a.id));
  $('vehList').innerHTML = list.map((p) => `
    <button class="vitem${current && p.id === current.id ? ' sel' : ''}${highlight.includes(p.id) ? ' hl' : ''}" data-id="${p.id}" ${p.err ? 'disabled' : ''}>
      ${p.custom ? '📄 ' : ''}${escapeHtml(p.name)}
      <small>${p.err ? 'Profil invalide : ' + escapeHtml(p.err) : escapeHtml(p.source || '')}</small>
    </button>`).join('') || '<div style="color:var(--muted);padding:8px">Aucun profil.</div>';
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
$('vehBtn').addEventListener('click', openVeh);
$('btnClose').addEventListener('click', () => $('vehDlg').close());
$('vehSearch').addEventListener('input', renderVehList);
$('vehList').addEventListener('click', (e) => {
  const b = e.target.closest('.vitem'); if (!b) return;
  selectProfile(PROFILES.find((p) => p.id === b.dataset.id));
  $('vehDlg').close();
});

// Import d'un profil ABRP (.json)
$('btnImport').addEventListener('click', () => $('fileImport').click());
$('fileImport').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const raw = JSON.parse(await f.text());
    const n = normalize(raw);
    const name = f.name.replace(/\.json$/i, '');
    const prof = { id: 'custom:' + name, name, makes: [], source: `Importé · ${Object.keys(n.pids).length} mesures`, profile: raw };
    const custom = store.get('customProfiles', []).filter((p) => p.id !== prof.id);
    custom.unshift(prof); store.set('customProfiles', custom);
    await loadProfiles();
    selectProfile(PROFILES.find((p) => p.id === prof.id));
    $('vehInfo').textContent = `Profil « ${name} » importé.`;
    renderVehList();
  } catch (err) { $('vehInfo').textContent = 'Import impossible : ' + err.message; }
});

// Détection par VIN (mode 09 PID 02) — les VE ne répondent pas tous
const WMI = {
  ZFA: 'fiat', WVW: 'volkswagen', WVG: 'volkswagen', WV1: 'volkswagen', WV2: 'volkswagen', WAU: 'audi',
  TMB: 'skoda', VSS: 'cupra seat', KMH: 'hyundai', KM8: 'hyundai', KNA: 'kia', KNE: 'kia', KND: 'kia',
  VF1: 'renault', UU1: 'dacia', WMW: 'mini', SAD: 'jaguar', '1G1': 'chevrolet', KL1: 'chevrolet',
  '3FM': 'ford', '1FM': 'ford', WF0: 'ford', LSJ: 'mg', SDP: 'mg', LJN: 'aiways', JHM: 'honda', SHH: 'honda', LHG: 'honda',
  JMZ: 'mazda', LVR: 'mazda', VF3: 'peugeot', VR3: 'peugeot', VF7: 'citroen', VXK: 'opel', W0L: 'opel',
};
$('btnVin').addEventListener('click', async () => {
  $('vehInfo').textContent = 'Lecture du VIN…';
  try {
    for (const c of ['ATD', 'ATE0', 'ATS0', 'ATH0', 'ATSP0']) await elm.send(c, 4000);
    const r = await elm.query('0902', '', 10000);
    if (!r.data) throw new Error(r.why);
    const vin = String.fromCharCode(...r.data.filter((x) => x >= 0x30 && x <= 0x5a)).slice(-17);
    const make = WMI[vin.slice(0, 3)] || '';
    highlight = PROFILES.filter((p) => make && (p.makes || []).some((m) => make.includes(m))).map((p) => p.id);
    $('vehInfo').textContent = `VIN ${vin} → ${make || 'constructeur inconnu'}` + (highlight.length ? ' : profils compatibles en tête de liste.' : make ? ' : aucun profil pour cette marque (essayez le mode découverte).' : '');
    renderVehList();
  } catch (e) {
    $('vehInfo').textContent = 'VIN non disponible (' + e.message + '). Beaucoup de VE ne le donnent pas : choisissez dans la liste.';
  } finally {
    if (current) await initProfile();
    setStatus('Connecté', 'on');
  }
});

/* ---------------- Mode découverte ---------------- */
let lastBytes = null;
$('dsend').addEventListener('click', async () => {
  const lines = $('dcmd').value.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return;
  $('dsend').disabled = true; $('dwhy').textContent = '…';
  try {
    for (const l of lines.slice(0, -1)) await elm.send(l, 4000);
    const last = lines[lines.length - 1];
    if (/^AT/i.test(last)) { await elm.send(last, 4000); $('dwhy').textContent = 'OK'; lastBytes = null; $('dbytes').innerHTML = ''; }
    else {
      const r = await elm.query(last, '', 6000);
      lastBytes = r.data;
      $('dwhy').textContent = r.data ? `${r.data.length} octets de données` : r.why;
      $('dbytes').innerHTML = (r.data || []).map((b, i) => `<div><b>${letters(i)}</b> ${b.toString(16).padStart(2, '0').toUpperCase()} <span style="color:var(--muted)">${b}</span></div>`).join('');
    }
    evalFormula();
  } catch (e) { $('dwhy').textContent = e.message; }
  finally { $('dsend').disabled = !elm.connected; }
});
function letters(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
function evalFormula() {
  const f = $('dformula').value.trim();
  if (!f) { $('fres').textContent = ''; return; }
  if (!lastBytes) { $('fres').textContent = 'Envoyez d\'abord une requête.'; return; }
  try { const v = Formula.evaluate(f, lastBytes); $('fres').textContent = '= ' + (+v.toFixed(4)); $('fres').style.color = ''; }
  catch (e) { $('fres').textContent = e.message; $('fres').style.color = 'var(--warn)'; }
}
$('dformula').addEventListener('input', evalFormula);

/* ---------------- Écran allumé & démarrage ---------------- */
async function requestWake() { try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {} }
$('wake').addEventListener('change', async (e) => {
  if (e.target.checked) await requestWake(); else if (wakeLock) { wakeLock.release(); wakeLock = null; }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && $('wake').checked) requestWake(); });

$('interval').value = String(store.get('interval', 30));
loadProfiles().then(() => { if (!current) openVeh(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
