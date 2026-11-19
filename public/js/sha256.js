/* Incremental SHA-256 as defined in FIPS 180-4. update() retains at most 63
   uncompressed input bytes. hex() snapshots the current digest without closing it. */
(() => {
  'use strict';
  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ]);
  const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits));
  class BeamSHA256 {
    constructor() {
      this.state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
        0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
      this.tail = new Uint8Array(64);
      this.words = new Uint32Array(64);
      this.used = 0;
      this.bytes = 0;
    }
    compress(chunk, pos) {
      const w = this.words;
      for (let i = 0; i < 16; i++, pos += 4) {
        w[i] = (chunk[pos] << 24) | (chunk[pos+1] << 16) | (chunk[pos+2] << 8) | chunk[pos+3];
      }
      for (let i = 16; i < 64; i++) {
        const x = w[i-15], y = w[i-2];
        const s0 = rotate(x,7) ^ rotate(x,18) ^ (x >>> 3);
        const s1 = rotate(y,17) ^ rotate(y,19) ^ (y >>> 10);
        w[i] = w[i-16] + s0 + w[i-7] + s1;
      }
      const s = this.state;
      let a=s[0], b=s[1], c=s[2], d=s[3];
      let e=s[4], f=s[5], g=s[6], h=s[7];
      for (let i = 0; i < 64; i++) {
        const s1 = rotate(e,6) ^ rotate(e,11) ^ rotate(e,25);
        const t1 = (h + s1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const s0 = rotate(a,2) ^ rotate(a,13) ^ rotate(a,22);
        const t2 = s0 + ((a & b) ^ (a & c) ^ (b & c));
        h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
      }
      s[0]+=a; s[1]+=b; s[2]+=c; s[3]+=d; s[4]+=e; s[5]+=f; s[6]+=g; s[7]+=h;
    }
    update(input) {
      const data = input instanceof Uint8Array ? input : new Uint8Array(input);
      this.bytes += data.length;
      let offset = 0;
      if (this.used) {
        const count = Math.min(64-this.used, data.length);
        this.tail.set(data.subarray(0,count), this.used);
        this.used += count;
        offset = count;
        if (this.used < 64) return this;
        this.compress(this.tail,0);
        this.used = 0;
      }
      while (offset + 64 <= data.length) {
        this.compress(data,offset);
        offset += 64;
      }
      if (offset < data.length) {
        this.tail.set(data.subarray(offset));
        this.used = data.length-offset;
      }
      return this;
    }
    hex() {
      const copy = new BeamSHA256();
      copy.state.set(this.state);
      const final = new Uint8Array(this.used < 56 ? 64 : 128);
      final.set(this.tail.subarray(0,this.used));
      final[this.used] = 0x80;
      const view = new DataView(final.buffer);
      view.setUint32(final.length-8, Math.floor(this.bytes / 0x20000000));
      view.setUint32(final.length-4, (this.bytes * 8) >>> 0);
      for (let i=0; i<final.length; i+=64) copy.compress(final,i);
      return Array.from(copy.state, x => x.toString(16).padStart(8,'0')).join('');
    }
  }
  globalThis.BeamSHA256 = BeamSHA256;
})();
