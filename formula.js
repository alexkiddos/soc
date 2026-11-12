/*
 * Interpréteur de formules au format ABRP / Torque Pro — sans eval().
 *   Variables : A..Z, AA..ZZ, AAA..  (insensible à la casse) = octets de données après l'écho
 *   Opérateurs : + - * / %  << >>  < > <= >= == !=  & | ^  && || !
 *   Fonctions : Int16(A,B) Int24(A,B,C) Int32(A,B,C,D) Signed(A) Signed16(A,B) abs min max round floor
 *               (séparateur « , » ou « : », ex. INT16(A:B))
 *   Bit       : {A:2} = bit n°2 (depuis le poids faible) de l'octet A
 */
(function (g) {
  'use strict';

  const OPS = ['<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
    '<', '>', '+', '-', '*', '/', '%', '!', '&', '|', '^', '(', ')', '{', '}', ':', ','];

  function tokenize(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      let m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
      if (m) { out.push({ t: 'num', v: parseFloat(m[1]) }); i += m[1].length; continue; }
      m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      if (m) { out.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
      const op = OPS.find((o) => src.startsWith(o, i));
      if (op) { out.push({ t: 'op', v: op }); i += op.length; continue; }
      throw new Error(`Caractère inattendu « ${c} » (position ${i})`);
    }
    return out;
  }

  // Lettres -> index d'octet (bijectif base 26 : A=0, Z=25, AA=26, AZ=51, BA=52…)
  function letterIndex(name) {
    let n = 0;
    for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  const PREC = {
    '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6,
    '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
  };
  const b = (x) => (x ? 1 : 0);
  const BIN = {
    '||': (x, y) => b(x || y), '&&': (x, y) => b(x && y),
    '|': (x, y) => (x | y) >>> 0, '^': (x, y) => (x ^ y) >>> 0, '&': (x, y) => (x & y) >>> 0,
    '==': (x, y) => b(x === y), '!=': (x, y) => b(x !== y),
    '<': (x, y) => b(x < y), '>': (x, y) => b(x > y), '<=': (x, y) => b(x <= y), '>=': (x, y) => b(x >= y),
    '<<': (x, y) => x * Math.pow(2, y), '>>': (x, y) => Math.floor(x / Math.pow(2, y)),
    '+': (x, y) => x + y, '-': (x, y) => x - y, '*': (x, y) => x * y, '/': (x, y) => x / y, '%': (x, y) => x % y,
  };
  const FN = {
    int16: (a, c) => a * 256 + c,
    int24: (a, c, d) => a * 65536 + c * 256 + d,
    int32: (a, c, d, e) => ((a * 256 + c) * 256 + d) * 256 + e,
    signed: (a) => (a >= 128 ? a - 256 : a),
    signed16: (a, c) => { const v = a * 256 + c; return v >= 32768 ? v - 65536 : v; },
    abs: Math.abs, min: Math.min, max: Math.max, round: Math.round, floor: Math.floor,
  };

  function compile(src) {
    const toks = tokenize(String(src));
    let p = 0;
    const peek = () => toks[p];
    const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;
    const expect = (v) => {
      if (!isOp(v)) throw new Error(`« ${v} » attendu`);
      p++;
    };
    const byteRef = (name) => {
      const idx = letterIndex(name);
      return (bytes) => {
        if (idx >= bytes.length) throw new RangeError(`Octet ${name.toUpperCase()} absent (réponse de ${bytes.length} octets)`);
        return bytes[idx];
      };
    };

    function primary() {
      const tk = peek();
      if (!tk) throw new Error('Formule incomplète');
      p++;
      if (tk.t === 'num') return () => tk.v;
      if (tk.t === 'op') {
        if (tk.v === '(') { const e = expr(0); expect(')'); return e; }
        if (tk.v === '-') { const e = primary(); return (x) => -e(x); }
        if (tk.v === '+') return primary();
        if (tk.v === '!') { const e = primary(); return (x) => b(!e(x)); }
        if (tk.v === '{') {
          const id = peek(); if (!id || id.t !== 'id') throw new Error('Octet attendu dans {X:n}');
          p++; const ref = byteRef(id.v); expect(':');
          const n = peek(); if (!n || n.t !== 'num') throw new Error('Numéro de bit attendu');
          p++; expect('}');
          return (x) => (ref(x) >> n.v) & 1;
        }
        throw new Error(`Opérateur inattendu « ${tk.v} »`);
      }
      // identifiant : fonction ou octet
      if (isOp('(')) {
        const fn = FN[tk.v.toLowerCase()];
        if (!fn) throw new Error(`Fonction inconnue ${tk.v}()`);
        p++;
        const args = [];
        if (!isOp(')')) {
          args.push(expr(0));
          while (isOp(',') || isOp(':')) { p++; args.push(expr(0)); }
        }
        expect(')');
        return (x) => fn(...args.map((a) => a(x)));
      }
      if (!/^[A-Za-z]+$/.test(tk.v)) throw new Error(`Variable inconnue ${tk.v}`);
      return byteRef(tk.v);
    }

    function expr(minPrec) {
      let left = primary();
      for (;;) {
        const tk = peek();
        if (!tk || tk.t !== 'op' || !(tk.v in PREC) || PREC[tk.v] < minPrec) break;
        const op = tk.v; p++;
        const right = expr(PREC[op] + 1);
        const l = left, f = BIN[op];
        left = (x) => f(l(x), right(x));
      }
      return left;
    }

    const fn = expr(0);
    if (p < toks.length) throw new Error(`Symbole en trop : « ${toks[p].v} »`);
    return fn;
  }

  const cache = new Map();
  function evaluate(src, bytes) {
    if (!cache.has(src)) cache.set(src, compile(src));
    return cache.get(src)(bytes);
  }

  g.Formula = { compile, evaluate, letterIndex };
})(typeof window !== 'undefined' ? window : globalThis);
