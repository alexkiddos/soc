/*
 * ELM327 sur Bluetooth Low Energy (Web Bluetooth) + décodage des réponses.
 * Gère : en-têtes affichés ou non (ATH), formatage auto ou trames brutes (ATCAF),
 * CAN 11/29 bits, réponses multi-trames ISO-TP, réponses « 7F xx 78 » (en attente).
 */
(function (g) {
  'use strict';

  const BLE_SERVICES = [0xfff0, 0xffe0, 0x18f0, 'e7810a71-73ae-499d-8c15-faa9aef0c3f2'];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const short = (u) => u.replace(/^0000(\w{4})-0000-1000-8000-00805f9b34fb$/i, '$1').toUpperCase();
  const hexBytes = (h) => { const o = []; for (let i = 0; i + 1 < h.length; i += 2) o.push(parseInt(h.substr(i, 2), 16)); return o; };
  const toHex = (arr) => arr.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');

  /* ---------- État de l'ELM, déduit des commandes AT envoyées ---------- */
  function defaultState() { return { h: false, caf: true, cea: false, bits: 0 }; }

  function updateState(st, cmd) {
    const c = cmd.toUpperCase().replace(/\s+/g, '');
    if (!c.startsWith('AT')) return;
    const a = c.slice(2);
    if (a === 'Z' || a === 'D' || a === 'WS') Object.assign(st, defaultState());
    else if (a === 'H1') st.h = true;
    else if (a === 'H0') st.h = false;
    else if (a === 'CAF1') st.caf = true;
    else if (a === 'CAF0') st.caf = false;
    else if (a.startsWith('CEA')) st.cea = a.length > 3;
    else if (/^SP[AB]?[0-9A-C]$/.test(a)) {
      const p = a.slice(-1);
      st.bits = '68'.includes(p) ? 11 : '79'.includes(p) ? 29 : st.bits;
    } else if (/^SH[0-9A-F]+$/.test(a)) st.bits = a.length - 2 >= 6 ? 29 : 11;
    else if (/^CP[0-9A-F]{2}$/.test(a)) st.bits = 29;
  }

  const ERR_RE = /NODATA|CANERROR|UNABLETOCONNECT|BUFFERFULL|BUSERROR|FBERROR|DATAERROR|^\?$|^ERR\d*/;
  const SKIP_RE = /^(SEARCHING|OK|STOPPED|BUSINIT|>)/;

  /* Découpe la réponse brute en messages {header, bytes} */
  function parseMessages(raw, cmd, st) {
    const cmdN = cmd.toUpperCase().replace(/\s+/g, '');
    const lines = raw.toUpperCase().split(/[\r\n]+/).map((l) => l.replace(/\s+/g, '')).filter(Boolean);
    const msgs = [];
    const errors = [];
    const rawFrames = st.h || !st.caf;
    const open = new Map(); // header -> message multi-trame en cours

    for (const line0 of lines) {
      let line = line0.replace(/\.\.\.$/, '');
      if (line === cmdN || SKIP_RE.test(line)) continue;
      if (ERR_RE.test(line)) { errors.push(line); continue; }
      if (!/^[0-9A-F:]+$/.test(line)) continue;

      if (!rawFrames) {
        // ATH0 + ATCAF1 : l'ELM réassemble, multi-trame présentée en "00E" puis "0:…", "1:…"
        if (/^[0-9A-F]{3}$/.test(line)) { const m = { header: '', bytes: [], len: parseInt(line, 16) }; msgs.push(m); open.set('', m); continue; }
        const mm = /^([0-9A-F]):(.*)$/.exec(line);
        if (mm && open.get('')) { open.get('').bytes.push(...hexBytes(mm[2])); continue; }
        msgs.push({ header: '', bytes: hexBytes(line) });
        open.delete('');
        continue;
      }

      // Trames brutes (en-tête affiché et/ou PCI ISO-TP visible)
      let header = '';
      if (st.h) {
        const hl = st.bits === 29 || (st.bits !== 11 && /^1[0-9A-F]{7}/.test(line) && line.length >= 12) ? 8 : 3;
        header = line.slice(0, hl);
        line = line.slice(hl);
      }
      let fr = hexBytes(line);
      if (st.cea && fr.length) fr = fr.slice(1);
      if (!fr.length) continue;
      const type = fr[0] >> 4;
      if (type === 0) {
        const n = fr[0] & 0x0f;
        msgs.push({ header, bytes: fr.slice(1, 1 + n) });
      } else if (type === 1 && fr.length > 1) {
        const m = { header, len: ((fr[0] & 0x0f) << 8) | fr[1], bytes: fr.slice(2) };
        msgs.push(m); open.set(header, m);
      } else if (type === 2) {
        const m = open.get(header);
        if (m) m.bytes.push(...fr.slice(1));
      } else if (type === 3) {
        // trame de contrôle de flux : ignorée
      } else {
        msgs.push({ header, bytes: fr }); // format inattendu : on garde tel quel
      }
    }
    for (const m of msgs) if (m.len) m.bytes = m.bytes.slice(0, m.len);
    return { msgs, errors };
  }

  /* Octets de la requête (sans PCI ni bourrage si la commande est une trame brute) */
  function requestBytes(cmd, st) {
    const h = cmd.toUpperCase().replace(/\s+/g, '');
    let req = hexBytes(h);
    if (!st.caf && req.length === 8 && req[0] > 0 && req[0] < 8) req = req.slice(1, 1 + req[0]);
    return req;
  }

  /* Renvoie {data, msg} : octets de données après l'écho (A = data[0]) */
  function extract(parsed, cmd, st, ecu) {
    const req = requestBytes(cmd, st);
    if (!req.length) return { data: null, why: 'commande vide' };
    const sid = req[0];
    const echoLen = sid === 0x22 ? 3 : [0x21, 0x01, 0x09, 0x1a].includes(sid) ? 2 : req.length;
    const echo = [sid + 0x40, ...req.slice(1, echoLen)];
    let cands = parsed.msgs;
    if (ecu) {
      const E = String(ecu).toUpperCase();
      const f = cands.filter((m) => m.header && (m.header.endsWith(E) || m.header === E));
      if (f.length) cands = f;
    }
    for (const m of cands) {
      if (echo.every((v, i) => m.bytes[i] === v)) return { data: m.bytes.slice(echo.length), msg: m };
    }
    const neg = cands.find((m) => m.bytes[0] === 0x7f && m.bytes[2] !== 0x78);
    if (neg) return { data: null, why: `refus ECU (7F ${toHex(neg.bytes.slice(1, 3))})` };
    if (parsed.errors.length) return { data: null, why: parsed.errors.join(', ') };
    return { data: null, why: 'pas de réponse attendue' };
  }

  /* ---------- Transport BLE ---------- */
  class Elm {
    constructor(log) {
      this.log = log || (() => {});
      this.buf = ''; this.waiter = null; this.queue = Promise.resolve();
      this.state = defaultState();
    }

    get connected() { return !!(this.device && this.device.gatt.connected && this.rx); }

    async connect() {
      const log = this.log;
      this.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
      this.device.addEventListener('gattserverdisconnected', () => {
        this.rx = this.tx = this.txCands = this.writeMode = null;
        this.onDisconnect && this.onDisconnect();
      });
      log(`Appareil : ${this.device.name || '(sans nom)'}`);
      const server = await this.device.gatt.connect();
      const services = [];
      for (const s of BLE_SERVICES) { try { services.push(await server.getPrimaryService(s)); } catch (_) {} }
      if (!services.length) throw new Error('Aucun service série BLE trouvé. Est-ce bien un dongle ELM327 BLE ?');

      const props = (c) => Object.entries({ R: c.properties.read, W: c.properties.write, Wnr: c.properties.writeWithoutResponse, N: c.properties.notify, I: c.properties.indicate })
        .filter(([, v]) => v).map(([k]) => k).join('/');
      const onData = (e) => {
        this.buf += new TextDecoder().decode(e.target.value);
        const i = this.buf.indexOf('>');
        if (i >= 0 && this.waiter) {
          const out = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
          const w = this.waiter; this.waiter = null; w.resolve(out);
        }
      };

      await sleep(500);
      for (const svc of services) {
        const chars = await svc.getCharacteristics();
        log(`Service ${short(svc.uuid)} : ` + chars.map((c) => `${short(c.uuid)}[${props(c)}]`).join(' '));
        const rxC = chars.filter((c) => c.properties.notify || c.properties.indicate)
          .sort((a, b) => /fff1|ffe1/i.test(b.uuid) - /fff1|ffe1/i.test(a.uuid));
        for (const c of rxC) {
          for (let k = 1; k <= 2 && !this.rx; k++) {
            try {
              c.addEventListener('characteristicvaluechanged', onData);
              await c.startNotifications();
              this.rx = c; log(`RX = ${short(c.uuid)}`);
            } catch (e) {
              c.removeEventListener('characteristicvaluechanged', onData);
              log(`Notifications refusées sur ${short(c.uuid)} (essai ${k}) : ${e.message}`);
              await sleep(400);
            }
          }
          if (this.rx) break;
        }
        if (!this.rx) continue;
        this.txCands = chars.filter((c) => c.properties.write || c.properties.writeWithoutResponse)
          .sort((a, b) => /fff2|ffe1/i.test(b.uuid) - /fff2|ffe1/i.test(a.uuid));
        if (this.txCands.length) break;
        this.rx = null;
      }
      if (!this.rx || !this.txCands || !this.txCands.length) throw new Error('Caractéristiques RX/TX utilisables introuvables (voir journal).');
      this.writeMode = null;
      this.state = defaultState();
    }

    async writeChunk(chunk) {
      if (this.writeMode) return this.writeMode(chunk);
      const errs = [];
      for (const c of this.txCands) {
        const modes = [];
        if (c.properties.writeWithoutResponse) modes.push(['sans réponse', (d) => c.writeValueWithoutResponse(d)]);
        if (c.properties.write) modes.push(['avec réponse', (d) => c.writeValueWithResponse(d)]);
        modes.push(['legacy', (d) => c.writeValue(d)]);
        for (const [name, fn] of modes) {
          try { await fn(chunk); this.writeMode = fn; this.log(`TX = ${short(c.uuid)} (${name})`); return; }
          catch (e) { errs.push(`${short(c.uuid)} ${name}: ${e.message}`); }
        }
      }
      throw new Error('Écriture impossible — ' + errs.join(' | '));
    }

    async write(str) {
      const bytes = new TextEncoder().encode(str);
      for (let i = 0; i < bytes.length; i += 20) await this.writeChunk(bytes.slice(i, i + 20));
    }

    /* Envoie une commande, attend le prompt « > ». Sérialisé. */
    send(cmd, timeout = 4000) {
      const run = async () => {
        this.buf = '';
        const p = new Promise((resolve, reject) => {
          this.waiter = { resolve };
          setTimeout(() => { if (this.waiter) { this.waiter = null; reject(new Error(`Timeout sur ${cmd}`)); } }, timeout);
        });
        await this.write(cmd + '\r');
        const raw = await p;
        const clean = raw.replace(/\r/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
        updateState(this.state, cmd);
        this.log(`> ${cmd}\n${clean}`);
        if (/^AT\s*(Z|WS)$/i.test(cmd.trim())) await sleep(600);
        return clean;
      };
      const r = this.queue.then(run, run);
      this.queue = r.catch(() => {});
      return r;
    }

    /* Requête OBD/UDS : renvoie {data, why, raw} */
    async query(cmd, ecu, timeout = 5000) {
      const st = { ...this.state };
      let raw;
      try { raw = await this.send(cmd, timeout); } catch (e) { return { data: null, why: e.message }; }
      const res = extract(parseMessages(raw, cmd, st), cmd, st, ecu);
      res.raw = raw;
      return res;
    }

    disconnect() { try { this.device && this.device.gatt.disconnect(); } catch (_) {} }
  }

  g.ELM = { Elm, parseMessages, extract, updateState, defaultState, toHex, hexBytes };
})(typeof window !== 'undefined' ? window : globalThis);
