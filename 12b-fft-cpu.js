/* ============================================================
   F13LD.lab · 12b-fft-cpu.js   (v0.21.0)
   CPU FFT — Cooley-Tukey radix-2 on interleaved Float64 complex
   arrays [re, im, re, im, …].  Used by the Float64 reference solvers
   (16a elastic, 16c buckling, 16f nonlinear via 16a, 17a thermal), the
   buckling workers and the node harnesses.  Moved verbatim out of the
   retired Stokes reference (18-stokes-cpu-ref.js, deleted in v0.21.0,
   Matt 2026-10-07: the lattice Boltzmann module replaces it).
   ============================================================ */

/* fft1d: in-place 1D FFT.  n = x.length / 2 must be a power of 2. */
function fft1dCpu(x, inverse) {
  var n = x.length >> 1;
  for (var i = 1, j = 0; i < n; i++) {
    var bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      var t = x[2*i]; x[2*i] = x[2*j]; x[2*j] = t;
      t = x[2*i+1]; x[2*i+1] = x[2*j+1]; x[2*j+1] = t;
    }
  }
  var sign = inverse ? 1 : -1;
  for (var len = 2; len <= n; len <<= 1) {
    var ang = sign * 2 * Math.PI / len;
    var wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (var i2 = 0; i2 < n; i2 += len) {
      var curRe = 1, curIm = 0;
      var halfLen = len >> 1;
      for (var jj = 0; jj < halfLen; jj++) {
        var uRe = x[2*(i2+jj)],         uIm = x[2*(i2+jj)+1];
        var vRe = x[2*(i2+jj+halfLen)], vIm = x[2*(i2+jj+halfLen)+1];
        var tvRe = curRe*vRe - curIm*vIm;
        var tvIm = curRe*vIm + curIm*vRe;
        x[2*(i2+jj)]           = uRe + tvRe;
        x[2*(i2+jj)+1]         = uIm + tvIm;
        x[2*(i2+jj+halfLen)]   = uRe - tvRe;
        x[2*(i2+jj+halfLen)+1] = uIm - tvIm;
        var newRe = curRe*wRe - curIm*wIm;
        curIm = curRe*wIm + curIm*wRe;
        curRe = newRe;
      }
    }
  }
  if (inverse) for (var k = 0; k < x.length; k++) x[k] /= n;
}

/* fft3d: in-place 3D FFT on flat N³ complex array.
   Memory layout matches GPU: index = i*N² + j*N + k, with k innermost.
   Pre-allocated lineBuf (Float64Array length 2*N) avoids per-call alloc. */
function fft3dCpu(data, N, inverse, lineBuf) {
  /* The radix-2 line transform requires a power-of-two grid; a non-pow2 N
     silently produces NaN fields (and thus a non-converging solver). Fail
     loudly so a grid mistake never masquerades as a solver bug. */
  if ((N & (N - 1)) !== 0) throw new Error('fft3dCpu: N must be a power of two, got ' + N);
  var buf = lineBuf || new Float64Array(2 * N);
  for (var j = 0; j < N; j++) for (var k = 0; k < N; k++) {
    for (var i = 0; i < N; i++) { buf[2*i] = data[2*(i*N*N+j*N+k)]; buf[2*i+1] = data[2*(i*N*N+j*N+k)+1]; }
    fft1dCpu(buf, inverse);
    for (var i2 = 0; i2 < N; i2++) { data[2*(i2*N*N+j*N+k)] = buf[2*i2]; data[2*(i2*N*N+j*N+k)+1] = buf[2*i2+1]; }
  }
  for (var i3 = 0; i3 < N; i3++) for (var k2 = 0; k2 < N; k2++) {
    for (var j2 = 0; j2 < N; j2++) { buf[2*j2] = data[2*(i3*N*N+j2*N+k2)]; buf[2*j2+1] = data[2*(i3*N*N+j2*N+k2)+1]; }
    fft1dCpu(buf, inverse);
    for (var j3 = 0; j3 < N; j3++) { data[2*(i3*N*N+j3*N+k2)] = buf[2*j3]; data[2*(i3*N*N+j3*N+k2)+1] = buf[2*j3+1]; }
  }
  for (var i4 = 0; i4 < N; i4++) for (var j4 = 0; j4 < N; j4++) {
    for (var k3 = 0; k3 < N; k3++) { buf[2*k3] = data[2*(i4*N*N+j4*N+k3)]; buf[2*k3+1] = data[2*(i4*N*N+j4*N+k3)+1]; }
    fft1dCpu(buf, inverse);
    for (var k4 = 0; k4 < N; k4++) { data[2*(i4*N*N+j4*N+k4)] = buf[2*k4]; data[2*(i4*N*N+j4*N+k4)+1] = buf[2*k4+1]; }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { fft1dCpu: fft1dCpu, fft3dCpu: fft3dCpu };
}
