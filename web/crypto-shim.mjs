// Browser stand-in for the single node:crypto call used by contract.mjs
// (createHash('sha256').update(str).digest('hex')). Lets the browser run the kit's
// contract.mjs unchanged, so action IDs are identical to the Node runner's.
const ror = (x, n) => (x >>> n) | (x << (32 - n));
const primes = [];
for (let n = 2; primes.length < 64; n++) if (primes.every(p => n % p)) primes.push(n);
const frac = x => ((x - Math.floor(x)) * 0x100000000) >>> 0;
const H0 = primes.slice(0, 8).map(p => frac(Math.sqrt(p)));
const K = primes.map(p => frac(Math.cbrt(p)));

export function sha256Hex(message) {
  const bytes = new TextEncoder().encode(message);
  const len = bytes.length;
  const total = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  const bits = len * 8;
  dv.setUint32(total - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(total - 4, bits >>> 0);
  const H = H0.slice();
  const W = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      const s0 = ror(a, 7) ^ ror(a, 18) ^ (a >>> 3);
      const s1 = ror(b, 17) ^ ror(b, 19) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) >>> 0; });
  }
  return H.map(x => x.toString(16).padStart(8, '0')).join('');
}

export function createHash(algorithm) {
  if (algorithm !== 'sha256') throw new Error(`crypto-shim supports sha256 only, not ${algorithm}`);
  let data = '';
  return {
    update(chunk) { data += chunk; return this; },
    digest(encoding) {
      if (encoding !== 'hex') throw new Error('crypto-shim supports hex digest only');
      return sha256Hex(data);
    },
  };
}
