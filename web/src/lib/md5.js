// MD5 of bytes, as hex: R2 answers each uploaded chunk with its MD5 (the part's ETag), and the page
// compares it with its own. WebCrypto has no MD5, hence this (RFC 1321). About 100 MB/s: a few
// tens of ms per 8 MiB chunk.

const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
const K = new Int32Array(64)
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0

/** The MD5 of *bytes* (a Uint8Array or ArrayBuffer), lowercase hex. */
export function md5(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const n = data.length
  const padded = new Uint8Array(((n + 8) >> 6) * 64 + 64)
  padded.set(data)
  padded[n] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, (n * 8) >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(n / 0x20000000), true)
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476
  const M = new Int32Array(16)
  for (let off = 0; off < padded.length; off += 64) {
    for (let j = 0; j < 16; j++) M[j] = view.getInt32(off + j * 4, true)
    let a = a0, b = b0, c = c0, d = d0
    for (let i = 0; i < 64; i++) {
      let f, g
      if (i < 16) (f = (b & c) | (~b & d)), (g = i)
      else if (i < 32) (f = (d & b) | (~d & c)), (g = (5 * i + 1) & 15)
      else if (i < 48) (f = b ^ c ^ d), (g = (3 * i + 5) & 15)
      else (f = c ^ (b | ~d)), (g = (7 * i) & 15)
      const t = d
      d = c
      c = b
      const x = (a + f + K[i] + M[g]) | 0
      const s = S[(i >> 4) * 4 + (i & 3)]
      b = (b + ((x << s) | (x >>> (32 - s)))) | 0
      a = t
    }
    a0 = (a0 + a) | 0
    b0 = (b0 + b) | 0
    c0 = (c0 + c) | 0
    d0 = (d0 + d) | 0
  }
  const out = new DataView(new ArrayBuffer(16))
  ;[a0, b0, c0, d0].forEach((v, i) => out.setInt32(i * 4, v, true))
  return Array.from(new Uint8Array(out.buffer), (x) => x.toString(16).padStart(2, '0')).join('')
}
