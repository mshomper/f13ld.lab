#!/usr/bin/env python3
"""
patch_16b_applyA_batchaware.py  —  make _applyA tolerant of the FFT plan's batch.

Regression: Step 2 made _applyA unconditionally call loadFromBuffers(6), which
throws on a batch=1 plan.  The nonlinear solver borrows ElasticSolverFull with a
batch=1 plan and drives _applyA via es.homogenizeFull/solveLoadCaseFull.

Fix: branch on `batched = (this.fft.batch >= 6)`.
  - batched  -> the collapsed 6->1 path (current Step-2 code)
  - else     -> the original per-component path, lifted VERBATIM from /tmp/16b.bak

Edits applied bottom-to-top by verified line range; CRLF preserved; idempotent.
"""
import sys

PATH = "16b-elastic-solver-full.js"
BAK  = "/tmp/16b.bak"

with open(PATH, "r", newline="") as fh:
    cur = fh.readlines()
with open(BAK, "r", newline="") as fh:
    bak = fh.readlines()

if any("var batched = (this.fft.batch" in ln for ln in cur):
    sys.exit("ALREADY PATCHED — batch-aware marker present; aborting.")

def eol_of(ln):
    return "\r\n" if ln.endswith("\r\n") else ("\n" if ln.endswith("\n") else "")

def check(lines, idx, needle, tag):
    if needle not in lines[idx]:
        sys.exit("SENTINEL FAIL [%s] line %d: want %r got %r" % (tag, idx + 1, needle, lines[idx]))

def indent(block):
    """Prepend two spaces to content lines; leave blank lines bare."""
    out = []
    for ln in block:
        if ln.strip() == "":
            out.append(ln)
        else:
            out.append("  " + ln)
    return out

# ---- verify sentinels on the CURRENT file (0-indexed) ------------------------
check(cur, 648, "var d = this.device;",                   "cur:d")
check(cur, 682, "for (var Q = 0; Q < 6; Q++) {",          "cur:fwd-start")
check(cur, 700, "storeToBuffers(enc, this.tauHat);",       "cur:fwd-end")
check(cur, 712, "for (var P = 0; P < 6; P++) {",           "cur:inv-start")
check(cur, 749, "loadFromBuffers(enc, this.depsHat);",     "cur:inv-batched")
check(cur, 753, "for (var P2 = 0; P2 < 6; P2++) {",        "cur:inv-deaccum")
check(cur, 768, "}",                                       "cur:inv-end")

# ---- verify sentinels on the BACKUP (original singular loops) ----------------
check(bak, 682, "for (var Q = 0; Q < 6; Q++) {",           "bak:fwd-start")
check(bak, 697, "storeToBuffer(enc, this.tauHat[Q]);",      "bak:fwd-end")
check(bak, 698, "}",                                        "bak:fwd-close")
check(bak, 710, "for (var P = 0; P < 6; P++) {",            "bak:inv-start")
check(bak, 744, "loadFromBuffer(enc, this.depsHat[P]);",    "bak:inv-fft")
check(bak, 763, "}",                                        "bak:inv-close")

eol = eol_of(cur[648])

# ---- capture current (batched) blocks as the IF branch -----------------------
cur_fwd = cur[682:701]   # pack loop + batched forward (lines 683..701)
cur_inv = cur[712:769]   # gammaAccum loop + batched IFFT + deAccum loop (713..769)

# ---- capture backup (singular) blocks as the ELSE branch ---------------------
bak_fwd = bak[682:699]   # original interleaved forward loop (683..699)
bak_inv = bak[710:764]   # original interleaved inverse loop (711..764)

def wrap(if_block, else_block):
    return ([ "  if (batched) {" + eol ]
            + indent(if_block)
            + [ "  } else {" + eol ]
            + indent(else_block)
            + [ "  }" + eol ])

new_fwd = wrap(cur_fwd, bak_fwd)
new_inv = wrap(cur_inv, bak_inv)

flag = [
    eol,
    "  /* Plan-batch-aware: the elastic standalone hands _applyA a batched plan" + eol,
    "     (batch >= 6) -> collapsed 6->1 FFT path.  Consumers that borrow" + eol,
    "     ElasticSolverFull with a single-transform plan (e.g. the nonlinear" + eol,
    "     solver's es) -> original per-component path.  Identical math. */" + eol,
    "  var batched = (this.fft.batch >= 6);" + eol,
]

# ---- apply bottom-to-top (indices computed on the original current file) -----
cur[712:769] = new_inv     # inverse region
cur[682:701] = new_fwd     # forward region
cur[649:649] = flag        # insert flag just after `var d = this.device;`

with open(PATH, "w", newline="") as fh:
    fh.write("".join(cur))

print("patched %s — _applyA is now plan-batch-aware (batched + singular fallback)" % PATH)
