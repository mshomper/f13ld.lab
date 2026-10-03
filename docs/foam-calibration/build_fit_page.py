"""Inline the foam run matrices into foam-fit.html (self-contained page).

    python3 docs/foam-calibration/build_fit_page.py
"""
import os
HERE = os.path.dirname(os.path.abspath(__file__))
def read(name):
    p = os.path.join(HERE, name)
    return open(p, encoding='utf-8').read().strip() if os.path.exists(p) else ''
src = read('foam-fit.src.html')
out = src.replace('__RUNS_CALIBRATION__', read('foam_calibration_runs.csv')).replace('__RUNS_PLATEAU__', read('foam_plateau_runs.csv'))
open(os.path.join(HERE, 'foam-fit.html'), 'w', encoding='utf-8').write(out)
print('wrote foam-fit.html (%d KB)' % (len(out) // 1024))
