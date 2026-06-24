#!/usr/bin/env python3
"""
patch_16b_batched_fft.py  —  wire the batched FFTPlan into 16b's applyA.

Strategy: edit by VERIFIED LINE RANGE (sentinel-guarded), bottom-to-top so
earlier indices stay valid. Preserves each region's existing line ending
(16b is mixed CRLF). Never uses str_replace on this file. Idempotency guard:
refuses to run if the batched markers are already present.
"""
import sys

PATH = "16b-elastic-solver-full.js"

with open(PATH, "r", newline="") as fh:
    lines = fh.readlines()          # keeps \r\n / \n exactly as stored

if any("loadFromBuffers(enc, this.tauCmplx)" in ln for ln in lines):
    sys.exit("ALREADY PATCHED — batched markers present; aborting.")

def ending(idx):
    ln = lines[idx]
    return "\r\n" if ln.endswith("\r\n") else ("\n" if ln.endswith("\n") else "")

def check(idx, needle):
    if needle not in lines[idx]:
        sys.exit("SENTINEL FAIL at 1-indexed line %d: expected %r, got %r"
                 % (idx + 1, needle, lines[idx]))

def block(body, eol):
    """body: list of content lines (no endings) -> joined with eol each."""
    return [c + eol for c in body]

# ---- verify all sentinels BEFORE mutating ------------------------------------
# Plan-construction block: 1-indexed 1512..1521  -> 0-indexed 1511..1520
check(1511, "Reuse the global FFT plan")
check(1520, "var solver = new ElasticSolverFull(N, fft);")
# Inverse loop block: 1-indexed 711..764 -> 0-indexed 710..763
check(710,  "for (var P = 0; P < 6; P++) {")
check(744,  "this.fft.loadFromBuffer(enc, this.depsHat[P]);")
check(763,  "}")
# Forward loop block: 1-indexed 683..699 -> 0-indexed 682..698
check(682,  "for (var Q = 0; Q < 6; Q++) {")
check(697,  "this.fft.storeToBuffer(enc, this.tauHat[Q]);")
check(698,  "}")

# ---- new blocks (authored with the region's own EOL) -------------------------
eolP = ending(1511)
plan_new = block([
    "  /* Batched FFT plan (batch = 6 Voigt components) — cached separately",
    "     from the single-transform __sharedFFT that the buckling / Stokes",
    "     solvers share, so neither path clobbers the other. */",
    "  var fft;",
    "  if (window.__sharedFFTBatched && window.__sharedFFTBatched.N === N && window.__sharedFFTBatched.batch === 6) {",
    "    fft = window.__sharedFFTBatched;",
    "  } else {",
    "    if (window.__sharedFFTBatched) window.__sharedFFTBatched.destroy();",
    "    fft = new FFTPlan(N, 6);",
    "    window.__sharedFFTBatched = fft;",
    "  }",
    "  var solver = new ElasticSolverFull(N, fft);",
], eolP)

eolI = ending(710)
inverse_new = block([
    "  for (var P = 0; P < 6; P++) {",
    "    /* Write pass: depsHat[P] = \u0393[P][0]\u00b7tauHat[0] + \u0393[P][1]\u00b7tauHat[1] + \u0393[P][2]\u00b7tauHat[2] */",
    "    var gaWBg = d.createBindGroup({",
    "      layout: this.gaLayout,",
    "      entries: [",
    "        { binding: 0, resource: { buffer: this.tauHat[0] } },",
    "        { binding: 1, resource: { buffer: this.tauHat[1] } },",
    "        { binding: 2, resource: { buffer: this.tauHat[2] } },",
    "        { binding: 3, resource: { buffer: this.gamma[P][0] } },",
    "        { binding: 4, resource: { buffer: this.gamma[P][1] } },",
    "        { binding: 5, resource: { buffer: this.gamma[P][2] } },",
    "        { binding: 6, resource: { buffer: this.depsHat[P] } },",
    "        { binding: 7, resource: { buffer: this.sizeParamsBuf } }",
    "      ]",
    "    });",
    "    this._dispatchEncoded(enc, this.gaWritePipeline, gaWBg, this.N3, 64);",
    "",
    "    /* Add pass: depsHat[P] += \u0393[P][3]\u00b7tauHat[3] + \u0393[P][4]\u00b7tauHat[4] + \u0393[P][5]\u00b7tauHat[5] */",
    "    var gaABg = d.createBindGroup({",
    "      layout: this.gaLayout,",
    "      entries: [",
    "        { binding: 0, resource: { buffer: this.tauHat[3] } },",
    "        { binding: 1, resource: { buffer: this.tauHat[4] } },",
    "        { binding: 2, resource: { buffer: this.tauHat[5] } },",
    "        { binding: 3, resource: { buffer: this.gamma[P][3] } },",
    "        { binding: 4, resource: { buffer: this.gamma[P][4] } },",
    "        { binding: 5, resource: { buffer: this.gamma[P][5] } },",
    "        { binding: 6, resource: { buffer: this.depsHat[P] } },",
    "        { binding: 7, resource: { buffer: this.sizeParamsBuf } }",
    "      ]",
    "    });",
    "    this._dispatchEncoded(enc, this.gaAddPipeline, gaABg, this.N3, 64);",
    "  }",
    "",
    "  /* Batched inverse FFT — all 6 rows of depsHat in ONE stage-set (12 IFFTs",
    "     -> 1).  Every row's gammaAccum is finished above (rows are independent),",
    "     so the single batched IFFT is order-safe; deAccum then runs per row. */",
    "  this.fft.loadFromBuffers(enc, this.depsHat);",
    "  this.fft.inverseEncoded(enc);",
    "  this.fft.storeToBuffers(enc, this.depsC);",
    "",
    "  for (var P2 = 0; P2 < 6; P2++) {",
    "    /* deAccumLane: out.{n,s}[lane(P2)] += Re(depsC[P2]).  Read-modify-write",
    "       on out (pre-seeded with epsIn above).  P2 < 3 -> lane P2 of {n};",
    "       P2 >= 3 -> lane (P2-3) of {s}.  Rows write distinct lanes -> order-free. */",
    "    var destBuf = (P2 < 3) ? out.n : out.s;",
    "    var laneBuf2 = this.laneParamsBufs[P2];",
    "    var daBg = d.createBindGroup({",
    "      layout: this.daLayout,",
    "      entries: [",
    "        { binding: 0, resource: { buffer: destBuf } },",
    "        { binding: 1, resource: { buffer: this.depsC[P2] } },",
    "        { binding: 2, resource: { buffer: laneBuf2 } }",
    "      ]",
    "    });",
    "    this._dispatchEncoded(enc, this.daPipeline, daBg, this.N3, 64);",
    "  }",
], eolI)

eolF = ending(682)
forward_new = block([
    "  for (var Q = 0; Q < 6; Q++) {",
    "    var srcBuf = (Q < 3) ? this.tau.n : this.tau.s;",
    "    var laneBuf = this.laneParamsBufs[Q];",
    "    var pcBg = d.createBindGroup({",
    "      layout: this.pcLayout,",
    "      entries: [",
    "        { binding: 0, resource: { buffer: srcBuf } },",
    "        { binding: 1, resource: { buffer: this.tauCmplx[Q] } },",
    "        { binding: 2, resource: { buffer: laneBuf } }",
    "      ]",
    "    });",
    "    this._dispatchEncoded(enc, this.pcPipeline, pcBg, this.N3, 64);",
    "  }",
    "",
    "  /* Batched forward FFT — all 6 Voigt components in ONE stage-set (6 FFTs",
    "     -> 1).  Packs above filled tauCmplx[0..5]; gather, transform, scatter. */",
    "  this.fft.loadFromBuffers(enc, this.tauCmplx);",
    "  this.fft.forwardEncoded(enc);",
    "  this.fft.storeToBuffers(enc, this.tauHat);",
], eolF)

# ---- apply bottom-to-top -----------------------------------------------------
lines[1511:1521] = plan_new      # plan construction (lowest impact, deepest line)
lines[710:764]   = inverse_new   # inverse loop split
lines[682:699]   = forward_new   # forward loop collapse

with open(PATH, "w", newline="") as fh:
    fh.write("".join(lines))

print("patched %s  (+plan, +forward batch, +inverse batch)" % PATH)
