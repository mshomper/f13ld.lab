/* ============================================================
   F13LD.lab · 23-flow-viz.js   (v0.29.0 — flow view)
   The velocity field of a Flow run, combined for a chosen flow direction,
   and the tracer particles the Flow tab animates through it.

   Fields (19g flowVizAddAxis): per open axis j, ũ_j = velocity for a unit
   body force along j ÷ N², at M = min(N, 64), half precision.  Flow is
   linear at these speeds, so the field for a mean flow along d is
       u = Σ_j G_j ũ_j,   G ∝ K⁻¹ d
   (K the permeability tensor; d restricted to open axes when one is
   closed).  It is normalized so the mean speed over the open pores is 1:
   colours read "× mean speed" until flow rate arrives with Phase 2.

   flowVizField(fr, dirKey)  dirKey 'x' | 'y' | 'z' | 'xyz'
     → { M, vel (Float32 3·M³), spd (Float32 M³), mask, fluid (Int32 list),
         hi (98th percentile of speed ÷ mean), dir, key } | null
   new FlowParticles()       CPU tracers; the raymarcher (21) calls
     setField(f), advance(dtSec), vertices() each frame.
   flowTurbo(x)              the raymarcher's turbo ramp, in JS
   ============================================================ */

var FLOW_VIZ_DIRS = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], xyz: [0.5773503, 0.5773503, 0.5773503] };

function _flowVizDecode(viz, ax) {
  if (!viz._f32) viz._f32 = [null, null, null];
  if (!viz._f32[ax] && viz.u[ax]) viz._f32[ax] = thermalHalfToFloat(viz.u[ax]);
  return viz._f32[ax];
}
function _inv3(K) {
  var a = K[0], b = K[1], c = K[2], d = K[3], e = K[4], f = K[5], g = K[6], h = K[7], i = K[8];
  var A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-30)) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
          B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
          C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

function flowVizField(fr, dirKey) {
  var viz = fr && !fr.error && fr.viz;
  if (!viz) return null;
  dirKey = FLOW_VIZ_DIRS[dirKey] ? dirKey : 'x';
  if (!viz._dir) viz._dir = {};
  if (viz._dir[dirKey]) return viz._dir[dirKey];
  var d = FLOW_VIZ_DIRS[dirKey].slice(), open = [0, 1, 2].map(function (a) { return !!viz.u[a]; });
  for (var a0 = 0; a0 < 3; a0++) if (!open[a0]) d[a0] = 0;
  if (!(d[0] || d[1] || d[2])) return null;
  /* force direction for a mean flow along d */
  var G = d;
  if (open[0] && open[1] && open[2] && fr.Ksym) {
    var Ki = _inv3(fr.Ksym);
    if (Ki) G = [Ki[0] * d[0] + Ki[1] * d[1] + Ki[2] * d[2], Ki[3] * d[0] + Ki[4] * d[1] + Ki[5] * d[2], Ki[6] * d[0] + Ki[7] * d[1] + Ki[8] * d[2]];
  }
  var M = viz.M, M3 = M * M * M, vel = new Float32Array(3 * M3), spd = new Float32Array(M3);
  for (var ax = 0; ax < 3; ax++) {
    if (!open[ax] || !G[ax]) continue;
    var src = _flowVizDecode(viz, ax), gj = G[ax];
    for (var p = 0; p < 3 * M3; p++) vel[p] += gj * src[p];
  }
  var sum = 0, nf = 0, fluid = [];
  for (var q = 0; q < M3; q++) {
    var vx = vel[3 * q], vy = vel[3 * q + 1], vz = vel[3 * q + 2], sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
    spd[q] = sp;
    if (viz.mask[q]) { sum += sp; nf++; fluid.push(q); }
  }
  var mean = nf ? sum / nf : 0;
  if (!(mean > 0)) return null;
  var inv = 1 / mean;
  for (var r = 0; r < 3 * M3; r++) vel[r] *= inv;
  for (var t = 0; t < M3; t++) spd[t] *= inv;
  var vals = new Float32Array(fluid.length);
  for (var k = 0; k < fluid.length; k++) vals[k] = spd[fluid[k]];
  vals.sort();
  var hi = vals.length ? vals[Math.floor(0.98 * (vals.length - 1))] : 1;
  var out = { M: M, vel: vel, spd: spd, mask: viz.mask, fluid: Int32Array.from(fluid), hi: hi > 0 ? hi : 1, dir: d, key: dirKey };
  viz._dir[dirKey] = out;
  return out;
}

/* JS copy of the raymarcher's turbo ramp (8 stops) */
var FLOW_TURBO = [[0.140, 0.150, 0.500], [0.150, 0.400, 0.950], [0.100, 0.700, 0.900], [0.150, 0.900, 0.550],
                  [0.550, 0.980, 0.250], [0.950, 0.850, 0.150], [0.970, 0.500, 0.150], [0.880, 0.130, 0.080]];
function flowTurbo(x) {
  x = Math.max(0, Math.min(1, x));
  var xs = x * 7, sg = Math.min(6, Math.floor(xs)), t = xs - sg, a = FLOW_TURBO[sg], b = FLOW_TURBO[sg + 1];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function flowTurboCss() {
  var s = [];
  for (var i = 0; i < FLOW_TURBO.length; i++) {
    var c = FLOW_TURBO[i];
    s.push('rgb(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ') ' + (100 * i / 7).toFixed(1) + '%');
  }
  return 'linear-gradient(to top,' + s.join(',') + ')';
}

/* ── tracer particles ─────────────────────────────────────────
   Positions in lattice units [0, M) (cell centres at integer + ½).  Each
   frame: midpoint (RK2) step through the trilinear periodic velocity, with
   sub-steps so no particle moves more than 0.7 cell per sub-step; the mean
   speed crosses the cell in about 1.5 s × 1/speed.  A particle that wraps
   through a face restarts its trail; one that ends up in solid, outlives
   its life or sits still re-spawns at a random open-pore cell.
   v0.29.1 — the trail is a pathline over a fixed span of flow time, not a
   fixed number of frames: a point is kept every `length` units of flow
   time (1 unit = one 60 Hz frame at speed 1), so faster fluid draws longer
   streaks but the animation speed no longer changes how long they are.
   The tail slides between its last two points so streaks keep a steady
   length.  vertices() → { data, nSeg }: 4 vertices per trail segment, 11
   floats each (pos 3, other end 3, side, end, along, speed, head), world
   coords. */
var FLOW_TRAIL = 12;
function FlowParticles() {
  this.n = 0; this.T = FLOW_TRAIL; this.field = null;
  this.playing = true; this.speed = 1; this.count = 2500;
  this.length = 1; this.size = 1; this.acc = 0;
  this._data = null;
}
FlowParticles.prototype.setLength = function (L) {
  this.length = Math.max(0.25, Math.min(2, +L || 1));
  if (this.acc > this.length) this.acc = 0;
};
FlowParticles.prototype.ready = function () { return !!this.field && this.n > 0; };
FlowParticles.prototype.setField = function (f) {
  if (this.field === f) return;
  this.field = f;
  this._alloc(this.count);
};
FlowParticles.prototype.setCount = function (n) {
  n = Math.max(200, Math.min(8000, Math.round(n)));
  if (n === this.count && this.n === n) return;
  this.count = n; if (this.field) this._alloc(n);
};
FlowParticles.prototype._alloc = function (n) {
  var T = this.T;
  this.n = n;
  this.pos = new Float32Array(3 * n); this.trail = new Float32Array(3 * n * T); this.tspd = new Float32Array(n * T);
  this.age = new Float32Array(n); this.life = new Float32Array(n); this.still = new Float32Array(n);
  for (var i = 0; i < n; i++) { this._spawn(i); this.age[i] = Math.random() * this.life[i]; }
  this._data = null;
};
FlowParticles.prototype._spawn = function (i) {
  var f = this.field, M = f.M, MM = M * M, c = f.fluid[(Math.random() * f.fluid.length) | 0];
  var x = Math.floor(c / MM), y = Math.floor(c / M) % M, z = c % M;
  this.pos[3 * i] = x + Math.random(); this.pos[3 * i + 1] = y + Math.random(); this.pos[3 * i + 2] = z + Math.random();
  this.age[i] = 0; this.life[i] = 140 + Math.random() * 180; this.still[i] = 0;
  this._resetTrail(i);
};
FlowParticles.prototype._resetTrail = function (i) {
  var T = this.T, M = this.field.M, k = 2 * Math.PI / M, b = 3 * i * T;
  var wx = -Math.PI + this.pos[3 * i] * k, wy = -Math.PI + this.pos[3 * i + 1] * k, wz = -Math.PI + this.pos[3 * i + 2] * k;
  var sp = this._speedAt(this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]);
  for (var t = 0; t < T; t++) { this.trail[b + 3 * t] = wx; this.trail[b + 3 * t + 1] = wy; this.trail[b + 3 * t + 2] = wz; this.tspd[i * T + t] = sp; }
};
/* trilinear periodic sample of the velocity at lattice point (x, y, z) into o */
FlowParticles.prototype._vel = function (x, y, z, o) {
  var f = this.field, M = f.M, MM = M * M, v = f.vel;
  var sx = x - 0.5, sy = y - 0.5, sz = z - 0.5;
  var i0 = Math.floor(sx), j0 = Math.floor(sy), k0 = Math.floor(sz), tx = sx - i0, ty = sy - j0, tz = sz - k0;
  i0 = ((i0 % M) + M) % M; j0 = ((j0 % M) + M) % M; k0 = ((k0 % M) + M) % M;
  var i1 = i0 + 1 === M ? 0 : i0 + 1, j1 = j0 + 1 === M ? 0 : j0 + 1, k1 = k0 + 1 === M ? 0 : k0 + 1;
  var ox = 0, oy = 0, oz = 0;
  for (var c = 0; c < 8; c++) {
    var ii = (c & 1) ? i1 : i0, jj = (c & 2) ? j1 : j0, kk = (c & 4) ? k1 : k0;
    var w = ((c & 1) ? tx : 1 - tx) * ((c & 2) ? ty : 1 - ty) * ((c & 4) ? tz : 1 - tz);
    var q = 3 * (ii * MM + jj * M + kk);
    ox += w * v[q]; oy += w * v[q + 1]; oz += w * v[q + 2];
  }
  o[0] = ox; o[1] = oy; o[2] = oz;
};
FlowParticles.prototype._speedAt = function (x, y, z) {
  var o = this._tmp || (this._tmp = new Float32Array(3));
  this._vel(x, y, z, o);
  return Math.sqrt(o[0] * o[0] + o[1] * o[1] + o[2] * o[2]);
};
FlowParticles.prototype.advance = function (dtSec) {
  if (!this.ready() || !this.playing) return;
  var f = this.field, M = f.M, MM = M * M, T = this.T, k = 2 * Math.PI / M, L = this.length;
  var frames = Math.min(3, Math.max(0, dtSec * 60));
  if (!(frames > 0)) return;
  /* flow time this frame, cut at the moments a trail point is kept */
  var tau = frames * this.speed, acc = this.acc, cuts = [], keeps = 0;
  while (acc + tau >= L && keeps < 64) { cuts.push(L - acc, 1); tau -= L - acc; acc = 0; keeps++; }
  if (acc + tau >= L) tau = 0.999 * (L - acc);
  cuts.push(tau, 0); acc += tau;
  this.acc = acc;
  var hu = M / 90;   /* cells per unit speed per unit flow time */
  var v1 = new Float32Array(3), v2 = new Float32Array(3);
  for (var i = 0; i < this.n; i++) {
    var b = 3 * i, x = this.pos[b], y = this.pos[b + 1], z = this.pos[b + 2], wrapped = false, gone = false;
    var tb = b * T, sb = i * T, sp = 0;
    for (var c = 0; c < cuts.length; c += 2) {
      var h = cuts[c] * hu;
      if (h > 0) {
        this._vel(x, y, z, v1);
        var s1 = Math.sqrt(v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2]);
        var nSub = Math.min(8, Math.max(1, Math.ceil(h * s1 / 0.7))), hs = h / nSub;
        for (var q = 0; q < nSub; q++) {
          if (q) this._vel(x, y, z, v1);
          this._vel(x + 0.5 * hs * v1[0], y + 0.5 * hs * v1[1], z + 0.5 * hs * v1[2], v2);
          x += hs * v2[0]; y += hs * v2[1]; z += hs * v2[2];
          if (x < 0 || x >= M || y < 0 || y >= M || z < 0 || z >= M) {
            wrapped = true;
            x = ((x % M) + M) % M; y = ((y % M) + M) % M; z = ((z % M) + M) % M;
          }
        }
      }
      var cell = Math.min(M - 1, x | 0) * MM + Math.min(M - 1, y | 0) * M + Math.min(M - 1, z | 0);
      if (!f.mask[cell]) { gone = true; break; }
      this.pos[b] = x; this.pos[b + 1] = y; this.pos[b + 2] = z;
      if (wrapped) { this._resetTrail(i); wrapped = false; continue; }
      sp = this._speedAt(x, y, z);
      /* the live head is the last point; keeping it shifts the trail */
      this.trail[tb + 3 * (T - 1)] = -Math.PI + x * k; this.trail[tb + 3 * (T - 1) + 1] = -Math.PI + y * k; this.trail[tb + 3 * (T - 1) + 2] = -Math.PI + z * k;
      this.tspd[sb + T - 1] = sp;
      if (cuts[c + 1]) {
        this.trail.copyWithin(tb, tb + 3, tb + 3 * T);
        this.tspd.copyWithin(sb, sb + 1, sb + T);
      }
    }
    if (gone) { this._spawn(i); continue; }
    this.age[i] += frames;
    if (!sp) sp = this._speedAt(x, y, z);
    this.still[i] = sp < 0.02 ? this.still[i] + frames : 0;
    if (this.age[i] > this.life[i] || this.still[i] > 60) this._spawn(i);
  }
};
FlowParticles.prototype.vertices = function () {
  var T = this.T, nSeg = this.n * (T - 1), F = 11, need = nSeg * 4 * F;
  if (!this._data || this._data.length !== need) this._data = new Float32Array(need);
  var D = this._data, o = 0, P = this.trail, ft = Math.min(1, this.acc / this.length);
  var t0 = this._t0 || (this._t0 = new Float32Array(3));
  for (var i = 0; i < this.n; i++) {
    var tb = 3 * i * T;
    /* tail point slid toward the next one by the flow time since the last keep */
    t0[0] = P[tb] + ft * (P[tb + 3] - P[tb]); t0[1] = P[tb + 1] + ft * (P[tb + 4] - P[tb + 1]); t0[2] = P[tb + 2] + ft * (P[tb + 5] - P[tb + 2]);
    for (var s = 0; s < T - 1; s++) {
      var a = tb + 3 * s, bq = a + 3, along = (s + 1) / (T - 1), head = (s === T - 2) ? 1 : 0, sp = this.tspd[i * T + s + 1];
      for (var v = 0; v < 4; v++) {
        var atB = v >= 2, side = (v & 1) ? 1 : -1, p = atB ? bq : a, q = atB ? a : bq;
        if (p === tb) { D[o++] = t0[0]; D[o++] = t0[1]; D[o++] = t0[2]; } else { D[o++] = P[p]; D[o++] = P[p + 1]; D[o++] = P[p + 2]; }
        if (q === tb) { D[o++] = t0[0]; D[o++] = t0[1]; D[o++] = t0[2]; } else { D[o++] = P[q]; D[o++] = P[q + 1]; D[o++] = P[q + 2]; }
        D[o++] = side; D[o++] = atB ? 1 : 0; D[o++] = atB ? along : along - 1 / (T - 1); D[o++] = sp; D[o++] = head;
      }
    }
  }
  return { data: D, nSeg: nSeg };
};
