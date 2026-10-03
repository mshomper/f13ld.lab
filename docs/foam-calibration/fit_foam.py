"""
F13LD.lab · docs/foam-calibration/fit_foam.py  (2026-10-03)
Fits F13LD.foam's stiffness laws to the calibration sweep (FOAM_CALIBRATION.md §6).

    python3 docs/foam-calibration/fit_foam.py [results.csv] [vf128.json]

Inputs
  results csv : the lab's sweep export (default: results_2026-10-03.csv here)
  runs csv    : foam_calibration_runs.csv here (feature widths, settings)
  vf128 json  : optional {run_id: {raw64, trim64, raw128, trim128}} — solid fraction
                at both grids (the export records only the run grid's)
Writes fit_foam.json next to this file and prints the tables used in §6.

Method
  1. Resolution.  Per family, model the grid error as E_h = E_inf (1 - a w^-p),
     w = wall / strut width in voxels, fitted to every run's 64 -> 128 ratio.
     Open: p ~ 2 over 8-35 %, so the lab's order-2 extrapolation is used as is.
     Closed: p ~ 2 from the 25-35 % runs; at 12-18 % the 64^3 walls are under
     2 voxels (the 64^3 solve is off the asymptotic curve), so E_inf is the
     128^3 value divided by (1 - a w128^-p).
  2. Directional mean E = (Ex + Ey + Ez) / 3, mean nu; G checked against the
     isotropic relation E / 2(1 + nu).
  3. Laws on set A (Lloyd seeds, 2 realizations):
       open   (plateau identical here, §6.2):  E/Es = C rho^n
       closed:                                  E/Es = a rho + b rho^2
     nu(rho) linear.  Seed-mode factors from set B (Poisson) and C (lattices).
  4. Stretch (set D): Ez/Exy normalized by the same seeds unstretched = s^m;
     shear split G_ij ~ (Ei Ej)^(r/2).
"""
import csv, json, math, os, sys
import numpy as np
from scipy.optimize import least_squares

HERE = os.path.dirname(os.path.abspath(__file__))
RES = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'results_2026-10-03.csv')
VF = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'vf_64_128.json')
res = {x['run_id']: x for x in csv.DictReader(open(RES))}
runs = {x['run_id']: x for x in csv.DictReader(open(os.path.join(HERE, 'foam_calibration_runs.csv')))}
vf = json.load(open(VF)) if os.path.exists(VF) else {}

def f(v):
    try: return float(v)
    except (TypeError, ValueError): return float('nan')

def g(k, pref, q): return f(res[k][pref + q])
AX = ('Ex', 'Ey', 'Ez'); SH = ('Gyz', 'Gxz', 'Gxy')
def mean(k, pref, qs): return sum(g(k, pref, q) for q in qs) / 3

def rho(k):
    """Solid fraction the solve saw: 128^3 after island trim when known, else 64^3."""
    if k in vf: return vf[k]['trim128']
    g2 = f(res[k].get('grid2_vf_measured_pct'))          # lab v0.15.1+ exports it
    if not math.isnan(g2): return g2 / 100
    return f(res[k]['vf_measured_pct']) / 100

# ── 1. resolution models ─────────────────────────────────────────────
def fit_res(ids):
    w = np.array([f(runs[k]['feature_vox_64']) for k in ids])
    R = np.array([mean(k, 'grid2_', AX) / mean(k, '', AX) for k in ids])
    s = least_squares(lambda q: (1 - q[0] * (2 * w) ** -q[1]) / (1 - q[0] * w ** -q[1]) - R, [1, 2], bounds=([0, 0.3], [50, 8]))
    return s.x[0], s.x[1], float(np.sqrt(np.mean(s.fun ** 2)))

open_ids = [k for k in res if k.startswith(('A-open', 'B-open'))]
closed_cal = ['A-closed-25-r1', 'A-closed-25-r2', 'A-closed-35-r1', 'A-closed-35-r2', 'B-closed-35']
ao, po, rmo = fit_res(open_ids)
ac, pc, rmc = fit_res(closed_cal)

def topo(k): return runs[k]['topology']
def closed_low(k):   # 64^3 walls under 2 voxels: use 128^3 + model correction
    return topo(k) == 'closed' and f(runs[k]['feature_vox_64']) < 2.0

def best(k, q):
    """Best estimate of one modulus (÷ Es) for run k."""
    if closed_low(k):
        w128 = f(runs[k]['feature_vox_128'])
        return g(k, 'grid2_', q) / (1 - ac * w128 ** -pc)
    return g(k, 'ext_', q)

def E(k): return sum(best(k, q) for q in AX) / 3
def G(k): return sum(best(k, q) for q in SH) / 3
def NU(k):
    if closed_low(k): return float('nan')   # no 128^3 Poisson ratios in the export
    return sum(f(res[k]['ext_' + q]) for q in ('nu_xy', 'nu_xz', 'nu_yz')) / 3

# ── 2-3. laws ────────────────────────────────────────────────────────
A = lambda t: sorted([k for k in res if k.startswith('A-' + t + '-')], key=rho)
op = A('open'); cl = A('closed')
x = np.log([rho(k) for k in op]); y = np.log([E(k) for k in op])
n_o, lnC = np.polyfit(x, y, 1); C_o = math.exp(lnC)
rms_o = float(np.sqrt(np.mean((y - (lnC + n_o * x)) ** 2)))
rc = np.array([rho(k) for k in cl]); ec = np.array([E(k) for k in cl])
(a_c, b_c), *_ = np.linalg.lstsq(np.vstack([rc, rc ** 2]).T, ec, rcond=None)
rms_c = float(np.sqrt(np.mean(np.log(ec / (a_c * rc + b_c * rc ** 2)) ** 2)))
nu_o = np.polyfit([rho(k) for k in op], [NU(k) for k in op], 1)
nuc = [(rho(k), NU(k)) for k in cl if not math.isnan(NU(k))]
nu_c = float(np.mean([v for _, v in nuc]))
law_o = lambda r: C_o * r ** n_o
law_c = lambda r: a_c * r + b_c * r * r

# realization scatter (r1 vs r2) and per-axis spread, set A
def pairs(t):
    out = []
    for lv in ('8', '12', '18', '25', '35'):
        a, b = 'A-%s-%s-r1' % (t, lv), 'A-%s-%s-r2' % (t, lv)
        if a in res and b in res: out.append(abs(E(a) - E(b)) / (E(a) + E(b)))
    return out
real_o, real_c = pairs('open'), pairs('closed')
axis_o = [max(abs(best(k, q) / E(k) - 1) for q in AX) for k in op]
axis_c = [max(abs(best(k, q) / E(k) - 1) for q in AX) for k in cl]

# seed-mode factors vs the law at the same rho
def fac(ids, law): return [E(k) / law(rho(k)) for k in ids]
poi_o = fac(['B-open-8', 'B-open-18', 'B-open-35', 'B-plateau-18'], law_o)
poi_c = fac(['B-closed-18', 'B-closed-35'], law_c)
lat = {k: E(k) / (law_o if topo(k) != 'closed' else law_c)(rho(k)) for k in res if k.startswith('C-')}

# ── 4. stretch ───────────────────────────────────────────────────────
def stretch(t, base):
    b0 = best(base, 'Ez') / ((best(base, 'Ex') + best(base, 'Ey')) / 2)
    gb = ((best(base, 'Gyz') + best(base, 'Gxz')) / 2) / best(base, 'Gxy')
    rows, ms, rs = [], [], []
    for s in (1.25, 1.5, 2.0):
        k = 'D-%s-sz%s' % (t, ('%g' % s))
        ez = best(k, 'Ez'); exy = (best(k, 'Ex') + best(k, 'Ey')) / 2
        ratio = (ez / exy) / b0
        gr = (((best(k, 'Gyz') + best(k, 'Gxz')) / 2) / best(k, 'Gxy')) / gb
        m = math.log(ratio) / math.log(s); r = math.log(gr) / math.log(ratio)
        ms.append(m); rs.append(r)
        rows.append(dict(s=s, Ez_over_Exy=ratio, m=m, mean_E_ratio=E(k) / E(base), G_ratio=gr, r=r))
    return rows, float(np.mean(ms)), float(np.mean(rs))
st_o, m_o, r_o = stretch('open', 'A-open-18-r1')
st_c, m_c, r_c = stretch('closed', 'A-closed-18-r1')

out = dict(
    date='2026-10-03', source=os.path.basename(RES), n_runs=len(res),
    resolution=dict(open=dict(a=ao, p=po, rms=rmo), closed=dict(a=ac, p=pc, rms=rmc)),
    open=dict(form='E/Es = C rho^n', C=C_o, n=n_o, rms_log=rms_o, nu=dict(form='nu = c0 + c1 rho', c0=nu_o[1], c1=nu_o[0]),
              realization_half_spread=float(np.mean(real_o)), axis_spread=float(np.mean(axis_o)),
              poisson_factor=float(np.mean(poi_o)), stretch_m=m_o, shear_r=r_o, rho_range=[0.08, 0.35], cells=27),
    closed=dict(form='E/Es = a rho + b rho^2', a=float(a_c), b=float(b_c), rms_log=rms_c, nu=nu_c,
                realization_half_spread=float(np.mean(real_c)), axis_spread=float(np.mean(axis_c)),
                poisson_factor=float(np.mean(poi_c)), stretch_m=m_c, shear_r=r_c, rho_range=[0.12, 0.35], cells=16),
    shear='G = E / 2(1 + nu) (isotropic relation; checked per run)',
    lattice_factors=lat)
json.dump(out, open(os.path.join(HERE, 'fit_foam.json'), 'w'), indent=1)

# ── print ────────────────────────────────────────────────────────────
print('resolution  open a=%.3f p=%.2f (rms %.3f) | closed a=%.3f p=%.2f (rms %.3f, 25-35 %% basis)' % (ao, po, rmo, ac, pc, rmc))
print('\nrun              rho     E/Es     law     G/[E/2(1+nu)]   nu')
for k in op + cl + ['B-open-8', 'B-open-18', 'B-open-35', 'B-closed-18', 'B-closed-35'] + sorted(lat):
    law = law_o if topo(k) != 'closed' else law_c
    nu = NU(k); giso = G(k) / (E(k) / (2 * (1 + nu))) if not math.isnan(nu) else float('nan')
    print('%-16s %.4f  %.5f  %.3f   %.3f   %.3f%s' % (k, rho(k), E(k), E(k) / law(rho(k)), giso, nu, '  (128 corrected)' if closed_low(k) else ''))
print('\nopen   E/Es = %.3f rho^%.3f   rms %.1f %%   nu = %.3f %+.3f rho' % (C_o, n_o, 100 * rms_o, nu_o[1], nu_o[0]))
print('closed E/Es = %.3f rho + %.3f rho^2   rms %.1f %%   nu = %.3f' % (a_c, b_c, 100 * rms_c, nu_c))
print('realization half-spread (27 / 16 cells): open %.1f %%  closed %.1f %%' % (100 * np.mean(real_o), 100 * np.mean(real_c)))
print('per-axis spread in one tile: open %.1f %%  closed %.1f %%' % (100 * np.mean(axis_o), 100 * np.mean(axis_c)))
print('Poisson-disk seeds vs Lloyd law: open %.3f  closed %.3f' % (np.mean(poi_o), np.mean(poi_c)))
print('stretch: open m=%.2f r=%.2f %s' % (m_o, r_o, ['s=%g: Ez/Exy %.2f m %.2f meanE %.3f' % (q['s'], q['Ez_over_Exy'], q['m'], q['mean_E_ratio']) for q in st_o]))
print('         closed m=%.2f r=%.2f %s' % (m_c, r_c, ['s=%g: Ez/Exy %.2f m %.2f meanE %.3f' % (q['s'], q['Ez_over_Exy'], q['m'], q['mean_E_ratio']) for q in st_c]))
for r in (0.05, 0.08, 0.12, 0.18, 0.25, 0.35):
    print('rho %.2f  open %.5f (Roberts-Garboczi %.5f)   closed %.5f (R-G %.5f)' % (r, law_o(r), 0.93 * r ** 2.04, law_c(r), 0.563 * r ** 1.19))
