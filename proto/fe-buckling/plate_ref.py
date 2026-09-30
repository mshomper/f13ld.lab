"""Exact continuum reference for the periodic plate benchmark (same linearized theory as the FE:
K + lambda*Kg with Kg energy = sigma_zz * sum_k (d_z u_k)^2), plane strain in x-z, y-uniform mode.
u_x = a(x) cos(kz), u_z = b(x) sin(kz), x in [0,t] with free faces.  1D quadratic FE through the
thickness (400 elements) -> converged to ~1e-9.  Prints sigma_cr/E for each (t, L)."""
import numpy as np, scipy.linalg as sl, json, sys
def ref(t, L, nu=0.34, ne=400):
    E=1.0; lam=E*nu/((1+nu)*(1-2*nu)); mu=E/(2*(1+nu)); k=2*np.pi/L
    nn=2*ne+1; K=np.zeros((2*nn,2*nn)); G=np.zeros_like(K); h=t/ne
    gp,gw=np.polynomial.legendre.leggauss(4)
    for e in range(ne):
        idx=[2*e,2*e+1,2*e+2]
        for xi,w in zip(gp,gw):
            N=np.array([xi*(xi-1)/2,1-xi*xi,xi*(xi+1)/2]); dN=np.array([xi-0.5,-2*xi,xi+0.5])*2/h; J=w*h/2
            # dofs: a at idx (cols 0..2), b (3..5)
            ea=np.concatenate([dN,np.zeros(3)])          # a'
            eb=np.concatenate([np.zeros(3),k*N])         # k b     (eps_zz amplitude, cos)
            gs=np.concatenate([-k*N,dN])                 # b' - k a (gamma amplitude, sin)
            Ke=(lam+2*mu)*(np.outer(ea,ea)+np.outer(eb,eb))+lam*(np.outer(ea,eb)+np.outer(eb,ea))+mu*np.outer(gs,gs)
            ga=np.concatenate([k*N,np.zeros(3)]); gb=np.concatenate([np.zeros(3),k*N])
            Ge=np.outer(ga,ga)+np.outer(gb,gb)
            dof=[2*i for i in idx]+[2*i+1 for i in idx]
            K[np.ix_(dof,dof)]+=J*Ke; G[np.ix_(dof,dof)]+=J*Ge
    w=sl.eigh(K,G,eigvals_only=True,subset_by_index=[0,0])
    return w[0]
out={}
for L in [32,64]:
    for t in [1,2,3,4,6,8]:
        kir=4*np.pi**2*t*t/(12*(1-0.34**2)*L*L)
        r=ref(t,L); out[f"{t}/{L}"]={"t":t,"L":L,"exact3D":r,"kirchhoff":kir,"ratio":r/kir}
        print(json.dumps(out[f"{t}/{L}"]))
json.dump(out,open(sys.argv[1] if len(sys.argv)>1 else "plate_ref.json","w"),indent=1)
