import numpy as np, struct, sys
from skimage.measure import marching_cubes
import os
OUT=os.environ.get('OUT','stl/')
os.makedirs(OUT, exist_ok=True)
def write_stl(path, verts, faces):
    tri = verts[faces].astype(np.float32)
    with open(path,'wb') as f:
        f.write(b'F13LD test'.ljust(80,b' ')); f.write(struct.pack('<I', len(tri)))
        rec = np.zeros(len(tri), dtype=[('n','<f4',3),('v','<f4',(3,3)),('a','<u2')])
        rec['v']=tri; f.write(rec.tobytes())
    print(path, len(tri), 'tris')
def mesh(g, R=160, L=5.0, lo=0.0, hi=1.0, shift=(0,0,0)):
    # g(u,v,w) field, negative inside; intersect with box [lo,hi]^3 (cell coords)
    pad=3; h=1.0/R
    ax = (np.arange(-pad, R+pad)+0.5)*h
    U,V,W = np.meshgrid(ax,ax,ax,indexing='ij')
    box = np.maximum.reduce([lo-U, U-hi, lo-V, V-hi, lo-W, W-hi])
    f = np.maximum(g(U,V,W), box)
    verts, faces, _, _ = marching_cubes(f, 0.0, spacing=(h,h,h))
    verts += ax[0]
    verts = verts*L + np.array(shift)
    return verts, faces
X=lambda u: 2*np.pi*u-np.pi
schwarz = lambda U,V,W: np.cos(X(U))+np.cos(X(V))+np.cos(X(W))
def gyroid_sheet(t):
    def g(U,V,W):
        x,y,z=X(U),X(V),X(W)
        return np.abs(np.sin(x)*np.cos(y)+np.sin(y)*np.cos(z)+np.sin(z)*np.cos(x)) - t
    return g
def sc_lattice(r, c=0.0):
    # struts along each axis through (c,c) lines, periodic
    def d(a,b): 
        da=np.abs(((a-c)+0.5)%1-0.5); db=np.abs(((b-c)+0.5)%1-0.5); return np.sqrt(da*da+db*db)
    return lambda U,V,W: np.minimum.reduce([d(V,W),d(U,W),d(U,V)]) - r
def two_net(r):
    a=sc_lattice(r,0.0); b=sc_lattice(r,0.5)
    return lambda U,V,W: np.minimum(a(U,V,W), b(U,V,W))
which = sys.argv[1:] or ['all']
if 'all' in which or 'p' in which:
    v,f = mesh(schwarz); write_stl(OUT+'schwarzP_5mm.stl', v, f)
    write_stl(OUT+'schwarzP_5mm_inch.stl', v/25.4, f)
    write_stl(OUT+'schwarzP_5mm_shifted.stl', v+np.array([12.3,-4.0,100.0]), f)
    v2,f2 = mesh(schwarz, hi=0.8); write_stl(OUT+'schwarzP_offperiod.stl', v2*1.25, f2)   # 80% of a period stretched to a 5 mm cell
    keep = np.ones(len(f), bool); keep[::400] = False; write_stl(OUT+'schwarzP_holes.stl', v, f[keep])
if 'all' in which or 'g' in which:
    v,f = mesh(gyroid_sheet(0.3)); write_stl(OUT+'gyroid_sheet_t03.stl', v, f)
if 'all' in which or 's' in which:
    v,f = mesh(sc_lattice(0.12)); write_stl(OUT+'sc_lattice_r012.stl', v, f)
    v,f = mesh(two_net(0.1)); write_stl(OUT+'two_networks.stl', v, f)
if 'big' in which:
    v,f = mesh(gyroid_sheet(0.3), R=230); write_stl(OUT+'gyroid_big.stl', v, f)
if 'aspect' in which:
    v,f = mesh(schwarz); 
    write_stl(OUT+'schwarzP_x101.stl', v*np.array([1.01,1,1]), f)
    write_stl(OUT+'schwarzP_x103.stl', v*np.array([1.03,1,1]), f)
