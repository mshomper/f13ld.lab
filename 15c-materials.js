/* ============================================================
   F13LD.lab · 15c-materials.js  (v0.7.2)
   Additive-manufacturing material library for the Material pill.
   Values: typical OEM / peer-reviewed data, orientation-averaged;
   Voce hardening fitted to yield, UTS and an ESTIMATED uniform
   elongation (no source publishes it).  Full table, per-entry notes,
   anisotropy and ~75 sources: docs/MATERIALS.md.  Reviewed and
   approved by Matt Shomper 2026-09-29.

   Entry → solver material: materialForSolver(id).  Poisson ratios
   marked nuFallback were not published for the AM condition and use a
   family value.  crushSupported=false (no yield data, or J2 does not
   apply, e.g. NiTi) skips the nonlinear crush with a reason.
   'recipe' = keep each design's own material (pre-0.7.2 behavior; the
   demos and imports without one use the F13LD Ti-6Al-4V default).
   ============================================================ */
var F13LD_MATERIAL_RECIPE_ID = 'recipe';

var F13LD_MATERIALS = [
  { id: "ti64-g23-lpbf-asbuilt", name: "Ti-6Al-4V ELI (Grade 23)", family: "Titanium", process: "LPBF (SLM 280/500, 30 um, 400 W)", condition: "As-built (no HT)",
    Es_MPa: 115000, nu: 0.342, rho_kgm3: 4430, sigY0_MPa: 1123, uts_MPa: 1285, elong_pct: 8.5,
    voce: { sigSat_MPa: 1407.9, delta: 38.68, Hlin_MPa: 0 }, ks_WmK: 7.1, muFluid_PaS: 0.001, crushSupported: true, source: "https://www.slm-solutions.com/fileadmin/Content/Powder/MDS/MDS_Ti-Alloy_Ti6Al4V__ELI_0719_EN.pdf" },
  { id: "ti64-g5-lpbf-sr", name: "Ti-6Al-4V (Grade 5)", family: "Titanium", process: "LPBF (EOS M290, 40 um)", condition: "Stress relieved / heat treated 800 C 2 h",
    Es_MPa: 112500, nu: 0.342, rho_kgm3: 4410, sigY0_MPa: 990, uts_MPa: 1080, elong_pct: 14.5,
    voce: { sigSat_MPa: 1315.5, delta: 10.93, Hlin_MPa: 0 }, ks_WmK: 6.7, muFluid_PaS: 0.001, crushSupported: true, source: "https://EOS.info/05-datasheet-images/Assets_MDS_Metal/EOS_Titanium_Ti64_Grade5/material_datasheet_eos_titanium_ti64_grade5_en_web.pdf" },
  { id: "ti64-g5-lpbf-hip", name: "Ti-6Al-4V (Grade 5)", family: "Titanium", process: "LPBF (3D Systems DMP)", condition: "HIP",
    Es_MPa: 112500, nu: 0.342, rho_kgm3: 4420, sigY0_MPa: 920, uts_MPa: 1010, elong_pct: 14.5,
    voce: { sigSat_MPa: 1227.6, delta: 11.22, Hlin_MPa: 0 }, ks_WmK: 6.7, muFluid_PaS: 0.001, crushSupported: true, source: "https://3dsystems.com/sites/default/files/2020-08/3d-systems-laserform-ti-gr5(a)-datasheet-usen-2020-07-24-a-print.pdf" },
  { id: "ti64-g23-lpbf-annealed", name: "Ti-6Al-4V ELI (Grade 23)", family: "Titanium", process: "LPBF (Renishaw RenAM 500, 60 um)", condition: "Annealed (per Renishaw)",
    Es_MPa: 117000, nu: 0.342, rho_kgm3: 4400, sigY0_MPa: 956.5, uts_MPa: 1048.5, elong_pct: 18,
    voce: { sigSat_MPa: 1363.5, delta: 7.31, Hlin_MPa: 0 }, ks_WmK: 7, muFluid_PaS: 0.001, crushSupported: true, source: "https://www.renishaw.com/media/pdf/en/0541d19b71c04d8f8952b9b379d406e3.pdf" },
  { id: "ti64-g23-lpbf-hip", name: "Ti-6Al-4V ELI (Grade 23)", family: "Titanium", process: "LPBF (SLM 280, 30 um, 400 W)", condition: "HIP 920 C / 1000 bar / 2 h",
    Es_MPa: 124000, nu: 0.342, rho_kgm3: 4430, sigY0_MPa: 878, uts_MPa: 982, elong_pct: 14,
    voce: { sigSat_MPa: 1175.9, delta: 13.02, Hlin_MPa: 0 }, ks_WmK: 7.1, muFluid_PaS: 0.001, crushSupported: true, source: "https://www.slm-solutions.com/fileadmin/Content/Powder/MDS/MDS_Ti-Alloy_Ti6Al4V__ELI_0719_EN.pdf" },
  { id: "ti64-g5-ebm-asbuilt", name: "Ti-6Al-4V (Grade 5)", family: "Titanium", process: "EB-PBF (Arcam Q10plus, 70 um)", condition: "As-built",
    Es_MPa: 113800, nu: 0.342, rho_kgm3: 4430, sigY0_MPa: 896, uts_MPa: 996.9, elong_pct: 14.4,
    voce: { sigSat_MPa: 1202.3, delta: 12.28, Hlin_MPa: 0 }, ks_WmK: 6.7, muFluid_PaS: 0.001, crushSupported: true, source: "https://www.ge.com/additive/sites/default/files/2023-03/TI64%20Q10%2070um%20V2.1.pdf" },
  { id: "cpti-g2-lpbf-asbuilt", name: "CP-Ti Grade 2", family: "Titanium", process: "LPBF (EOS M290 400 W)", condition: "As-built",
    Es_MPa: 105000, nu: 0.32, rho_kgm3: 4510, sigY0_MPa: 560, uts_MPa: 660, elong_pct: 22,
    voce: { sigSat_MPa: 887.4, delta: 6.98, Hlin_MPa: 0 }, ks_WmK: 16.4, muFluid_PaS: 0.001, crushSupported: true, source: "https://www.eos.info/05-datasheet-images/Assets_MDS_Metal/EOS_Titanium%20TiCP_Grade2/Material_DataSheet_EOS_Titanium_TiCPGrade2_EOSM290_EOSM400-4_en.pdf" },
  { id: "cpti-g2-lpbf-ht", name: "CP-Ti Grade 2", family: "Titanium", process: "LPBF (EOS M290 / M404)", condition: "Heat treated 700 C / 1.5-2 h, Ar",
    Es_MPa: 105000, nu: 0.32, rho_kgm3: 4510, sigY0_MPa: 437.5, uts_MPa: 567.5, elong_pct: 25,
    voce: { sigSat_MPa: 774.3, delta: 7.3, Hlin_MPa: 0 }, ks_WmK: 16.4, muFluid_PaS: 0.001, crushSupported: true, source: "https://www.eos.info/05-datasheet-images/Assets_MDS_Metal/EOS_Titanium%20TiCP_Grade2/Material_DataSheet_EOS_Titanium_TiCPGrade2_EOSM290_EOSM400-4_en.pdf" },
  { id: "cpti-g1-lpbf-sr", name: "CP-Ti Grade 1", family: "Titanium", process: "LPBF (3D Systems ProX DMP)", condition: "Stress relieved",
    Es_MPa: 112500, nu: 0.32, rho_kgm3: 4510, sigY0_MPa: 380, uts_MPa: 500, elong_pct: 29.5,
    voce: { sigSat_MPa: 729.8, delta: 5.53, Hlin_MPa: 0 }, ks_WmK: 16, muFluid_PaS: 0.001, crushSupported: true, source: "https://uk.3dsystems.com/sites/default/files/2017-12/3d-systems-laserform-ti-gr1%28a%29-datasheet-usen-2017-12-07-web.pdf" },
  { id: "ti6al7nb-lpbf-asbuilt", name: "Ti-6Al-7Nb", family: "Titanium", process: "LPBF (research, Hein et al. 2022)", condition: "As-built",
    Es_MPa: 105000, nu: 0.34, nuFallback: true, rho_kgm3: 4520, sigY0_MPa: 940, uts_MPa: 1109, elong_pct: 14.4,
    voce: { sigSat_MPa: 1312, delta: 16.43, Hlin_MPa: 0 }, ks_WmK: null, muFluid_PaS: 0.001, crushSupported: true, source: "https://www2.mdpi.com/2075-4701/12/1/122" },
  { id: "ti6al7nb-lpbf-sr", name: "Ti-6Al-7Nb", family: "Titanium", process: "LPBF (research, Hein et al. 2022)", condition: "Stress relief 600 C / 4 h (HT3)",
    Es_MPa: 116000, nu: 0.34, nuFallback: true, rho_kgm3: 4520, sigY0_MPa: 1045, uts_MPa: 1110, elong_pct: 12.5,
    voce: { sigSat_MPa: 1326.4, delta: 11.58, Hlin_MPa: 0 }, ks_WmK: null, muFluid_PaS: 0.001, crushSupported: true, source: "https://www2.mdpi.com/2075-4701/12/1/122" },
  { id: "ti2448-lpbf-asbuilt", name: "Ti-24Nb-4Zr-8Sn (beta Ti, Ti2448)", family: "Titanium", process: "LPBF (DMG Mori LT12, Z-loaded)", condition: "As-built",
    Es_MPa: 49000, nu: 0.34, nuFallback: true, rho_kgm3: null, sigY0_MPa: 490, uts_MPa: 700, elong_pct: 22,
    voce: { sigSat_MPa: 890.1, delta: 12.31, Hlin_MPa: 0 }, ks_WmK: null, muFluid_PaS: 0.001, crushSupported: true, source: "https://ris.uni-paderborn.de/download/33340/33341/Hein%20et%20al%20-%202022%20-%20Heat%20Treatments%20of%20Metastable%20%CE%B2%20Titanium%20Alloy%20Ti-24Nb-4Zr-8Sn%20Processed%20by%20Laser%20Powder%20Bed%20Fusion.pdf" },
  { id: "ss316l-lpbf-asbuilt", name: "316L stainless", family: "Stainless steel", process: "LPBF (EOS M290, 40 um)", condition: "As-built",
    Es_MPa: 180000, nu: 0.28, rho_kgm3: 7970, sigY0_MPa: 510, uts_MPa: 605, elong_pct: 45,
    voce: { sigSat_MPa: 1391.4, delta: 1.45, Hlin_MPa: 0 }, ks_WmK: 15, muFluid_PaS: 0.001, crushSupported: true, source: "https://www.eos.info/05-datasheet-images/Assets_MDS_Metal/EOS_StainlessSteel_316l/material_datasheet_eos_stainlesssteel_316l_en_web.pdf" },
  { id: "ss316l-lpbf-annealed", name: "316L stainless", family: "Stainless steel", process: "LPBF (3D Systems DMP Flex/Factory 350)", condition: "Full anneal",
    Es_MPa: 180000, nu: 0.28, rho_kgm3: 8000, sigY0_MPa: 345, uts_MPa: 575, elong_pct: 58.5,
    voce: { sigSat_MPa: 1229.2, delta: 2.19, Hlin_MPa: 0 }, ks_WmK: 15, muFluid_PaS: 0.001, crushSupported: true, source: "https://br.3dsystems.com/sites/default/files/2022-11/3d-systems-laserform-316l%28a%29-datasheet-usen-2022-11-14-a-print.pdf" },
  { id: "ss174-lpbf-h900", name: "17-4PH stainless", family: "Stainless steel", process: "LPBF (EOS M290, 40 um)", condition: "H900 (per EOS HT)",
    Es_MPa: 193000, nu: 0.3, rho_kgm3: 7750, sigY0_MPa: 1240, uts_MPa: 1360, elong_pct: 14,
    voce: { sigSat_MPa: 1646.4, delta: 11.28, Hlin_MPa: 0 }, ks_WmK: 18.3, muFluid_PaS: 0.001, crushSupported: true, source: "https://www.eos.info/metal-solutions/data-sheets/stainlesssteel/pds-eos-stainlesssteel-17-4ph-eos-m-290-40-80um" },
  { id: "ss174-lpbf-asbuilt", name: "17-4PH stainless", family: "Stainless steel", process: "LPBF (research, Li et al.)", condition: "As-built",
    Es_MPa: 193000, nu: 0.3, rho_kgm3: 7750, sigY0_MPa: 784, uts_MPa: 922, elong_pct: 16.7,
    voce: { sigSat_MPa: 1139.9, delta: 11.03, Hlin_MPa: 0 }, ks_WmK: 18.3, muFluid_PaS: 0.001, crushSupported: true, source: "https://arxiv.org/pdf/2112.06289" },
  { id: "ss155-lpbf-h900", name: "15-5PH stainless (EOS PH1)", family: "Stainless steel", process: "LPBF (EOS M290)", condition: "H900 modified",
    Es_MPa: 190000, nu: 0.28, rho_kgm3: 7700, sigY0_MPa: 1325, uts_MPa: 1445, elong_pct: 14,
    voce: { sigSat_MPa: 1752.9, delta: 11, Hlin_MPa: 0 }, ks_WmK: 17, muFluid_PaS: 0.001, crushSupported: true, source: "https://www.eos.info/05-datasheet-images/Assets_MDS_Metal/EOS_StainlessSteel_PH1/ss-ph1-m290_material_data_sheet_07-22_en.pdf" },
  { id: "ss155-lpbf-asbuilt", name: "15-5PH stainless (EOS PH1)", family: "Stainless steel", process: "LPBF (EOS M290)", condition: "As-built",
    Es_MPa: 190000, nu: 0.28, rho_kgm3: 7700, sigY0_MPa: 977.5, uts_MPa: 1200, elong_pct: 15.5,
    voce: { sigSat_MPa: 1440, delta: 14.79, Hlin_MPa: 0 }, ks_WmK: 17, muFluid_PaS: 0.001, crushSupported: true, source: "https://www.eos.info/05-datasheet-images/Assets_MDS_Metal/EOS_StainlessSteel_PH1/ss-ph1-m290_material_data_sheet_07-22_en.pdf" },
  { id: "ms1-lpbf-aged", name: "Maraging steel 1.2709 (EOS MS1)", family: "Stainless steel", process: "LPBF (EOS M290, 40 um)", condition: "Aged 490 C / 6 h",
    Es_MPa: 190000, nu: 0.3, nuFallback: true, rho_kgm3: null, sigY0_MPa: 2015, uts_MPa: 2092.5, elong_pct: 4.2,
    voce: { sigSat_MPa: 2180.6, delta: 102.31, Hlin_MPa: 0 }, ks_WmK: null, muFluid_PaS: 0.001, crushSupported: true, source: "https://eos.info/05-datasheet-images/Assets_MDS_Metal/EOS_MargingSteel_MS1/Material_DataSheet_EOS_MaragingSteel_MS1_en.pdf" },
  { id: "in718-lpbf-asbuilt", name: "Inconel 718", family: "Nickel superalloy", process: "LPBF (EOS M290, 40 um)", condition: "As-built",
    Es_MPa: 200000, nu: 0.29, rho_kgm3: 8190, sigY0_MPa: 725, uts_MPa: 1030, elong_pct: 28.5,
    voce: { sigSat_MPa: 1448.5, delta: 6.89, Hlin_MPa: 0 }, ks_WmK: 11.1, muFluid_PaS: 0.001, crushSupported: true, source: "https://eos.info/05-datasheet-images/Assets_MDS_Metal/EOS_NickelAlloy_IN718/Material_DataSheet_EOS_NickelAlloy_IN718_en.pdf" },
  { id: "in718-lpbf-sta", name: "Inconel 718", family: "Nickel superalloy", process: "LPBF (EOS M290, 40 um)", condition: "Solution + aged (AMS 5662-type)",
    Es_MPa: 200000, nu: 0.29, rho_kgm3: 8190, sigY0_MPa: 1192.5, uts_MPa: 1440, elong_pct: 14.5,
    voce: { sigSat_MPa: 1706.6, delta: 16.14, Hlin_MPa: 0 }, ks_WmK: 11.1, muFluid_PaS: 0.001, crushSupported: true, source: "https://eos.info/05-datasheet-images/Assets_MDS_Metal/EOS_NickelAlloy_IN718/Material_DataSheet_EOS_NickelAlloy_IN718_en.pdf" },
  { id: "in718-lpbf-hip-sta", name: "Inconel 718", family: "Nickel superalloy", process: "LPBF (Nikon SLM NXG 600, vertical)", condition: "HIP + solution + aged",
    Es_MPa: 200000, nu: 0.29, rho_kgm3: 8200, sigY0_MPa: 985, uts_MPa: 1290, elong_pct: 24,
    voce: { sigSat_MPa: 1726.4, delta: 8.15, Hlin_MPa: 0 }, ks_WmK: 11.1, muFluid_PaS: 0.001, crushSupported: true, source: "https://nikon-slm-solutions.com/wp-content/uploads/2024/07/mds-in718-2026-06.1-en.pdf" },
  { id: "in625-lpbf-sr", name: "Inconel 625", family: "Nickel superalloy", process: "LPBF (EOS M290, 40 um)", condition: "Stress relieved 870 C",
    Es_MPa: 209000, nu: 0.278, rho_kgm3: 8440, sigY0_MPa: 660, uts_MPa: 945, elong_pct: 41.5,
    voce: { sigSat_MPa: 1620.6, delta: 3.48, Hlin_MPa: 0 }, ks_WmK: 9.8, muFluid_PaS: 0.001, crushSupported: true, source: "https://eos.info/05-datasheet-images/Assets_MDS_Metal/EOS_NickelAlloy_IN625/Material_DataSheet_EOS_NickelAlloy_IN625_en.pdf" },
  { id: "hx-lpbf-asbuilt", name: "Hastelloy X", family: "Nickel superalloy", process: "LPBF (EOS M290 400 W)", condition: "As-built",
    Es_MPa: 185000, nu: 0.328, rho_kgm3: 8200, sigY0_MPa: 587.5, uts_MPa: 747.5, elong_pct: 33,
    voce: { sigSat_MPa: 1177.6, delta: 4.06, Hlin_MPa: 0 }, ks_WmK: 9.7, muFluid_PaS: 0.001, crushSupported: true, source: "https://www.eos.info/03_system-related-assets/material-related-contents/metal-materials-and-examples/metal-material-datasheet/nickelalloy-inconel/niall-hx-m290-400w_material_data_sheet_01-23_en.pdf" },
  { id: "hx-lpbf-hip", name: "Hastelloy X", family: "Nickel superalloy", process: "LPBF (Velo3D, vertical)", condition: "HIP 1177 C",
    Es_MPa: 159000, nu: 0.328, rho_kgm3: 8220, sigY0_MPa: 325, uts_MPa: 651, elong_pct: 56.9,
    voce: { sigSat_MPa: 1277.3, delta: 2.87, Hlin_MPa: 0 }, ks_WmK: 9.7, muFluid_PaS: 0.001, crushSupported: true, source: "https://cdn-dev.goengineer.com/velo3d-hastelloy-data-sheet.pdf" },
  { id: "h282-lpbf-ht", name: "Haynes 282", family: "Nickel superalloy", process: "LPBF (EOS M290, 40 um)", condition: "Heat treated (EOS option 1)",
    Es_MPa: 218000, nu: 0.31, rho_kgm3: 8300, sigY0_MPa: 710.5, uts_MPa: 1186.5, elong_pct: 26.9,
    voce: { sigSat_MPa: 1598.2, delta: 9.22, Hlin_MPa: 0 }, ks_WmK: 10.2, muFluid_PaS: 0.001, crushSupported: true, source: "https://www.eos.info/05-datasheet-images/Assets_MDS_Metal/EOS_NickelAlloy_HAYNES282/Material_DataSheet_EOS_NickelAlloy_Haynes282_en.pdf" },
  { id: "alsi10mg-lpbf-asbuilt", name: "AlSi10Mg", family: "Aluminium", process: "LPBF (3D Systems DMP)", condition: "As-built",
    Es_MPa: 71000, nu: 0.33, rho_kgm3: 2680, sigY0_MPa: 245, uts_MPa: 435, elong_pct: 6.5,
    voce: { sigSat_MPa: 463.1, delta: 83.16, Hlin_MPa: 0 }, ks_WmK: 125, muFluid_PaS: 0.001, crushSupported: true, source: "https://au.3dsystems.com/sites/default/files/2020-08/3d-systems-laserform-alsi10mg%28a%29-datasheet-usen-2020-07-27-a-print.pdf" },
  { id: "alsi10mg-lpbf-sr", name: "AlSi10Mg", family: "Aluminium", process: "LPBF (3D Systems DMP)", condition: "Stress relieved",
    Es_MPa: 73000, nu: 0.33, rho_kgm3: 2680, sigY0_MPa: 185, uts_MPa: 305, elong_pct: 10.5,
    voce: { sigSat_MPa: 339.4, delta: 37.66, Hlin_MPa: 0 }, ks_WmK: 165, muFluid_PaS: 0.001, crushSupported: true, source: "https://au.3dsystems.com/sites/default/files/2020-08/3d-systems-laserform-alsi10mg%28a%29-datasheet-usen-2020-07-27-a-print.pdf" },
  { id: "alsi10mg-lpbf-t6", name: "AlSi10Mg", family: "Aluminium", process: "LPBF (GKN Additive, vertical bars, as-built surface)", condition: "T6",
    Es_MPa: 80400, nu: 0.33, rho_kgm3: 2670, sigY0_MPa: 228.3, uts_MPa: 289.1, elong_pct: 7.2,
    voce: { sigSat_MPa: 311.8, delta: 50.15, Hlin_MPa: 0 }, ks_WmK: null, muFluid_PaS: 0.001, crushSupported: true, source: "https://gknpm.com/globalassets/downloads/gkn-additive/laser-am-materials/240627_material-data-sheet_alsi10mg.pdf" },
  { id: "scalmalloy-lpbf-aged", name: "Scalmalloy (Al-Mg-Sc-Zr)", family: "Aluminium", process: "LPBF (3D Systems DMP, 30 um)", condition: "Aged 325 C / 4 h",
    Es_MPa: 69000, nu: 0.33, rho_kgm3: 2670, sigY0_MPa: 490, uts_MPa: 520, elong_pct: 15.8,
    voce: { sigSat_MPa: 673.6, delta: 6.67, Hlin_MPa: 0 }, ks_WmK: 97.5, muFluid_PaS: 0.001, crushSupported: true, source: "https://3dsystems.com/sites/default/files/2022-02/3d-systems-certified-scalmalloy(a)-datasheet-usen-2022-02-23-a-print.pdf" },
  { id: "a20x-lpbf-t7", name: "A20X / A205 (Al-Cu-Ag-TiB2)", family: "Aluminium", process: "LPBF (Colibrium M2 Series 5, 400 W)", condition: "T7 (solution + age)",
    Es_MPa: 74500, nu: 0.33, rho_kgm3: null, sigY0_MPa: 397.5, uts_MPa: 467.5, elong_pct: 7.8,
    voce: { sigSat_MPa: 508.7, delta: 41.29, Hlin_MPa: 0 }, ks_WmK: null, muFluid_PaS: 0.001, crushSupported: true, source: "https://www.colibriumadditive.com/sites/default/files/M2SERIES5_A205_400W_CMDS_20250821_RevF%20%281%29.pdf" },
  { id: "al6061ram2-lpbf-t6", name: "A6061-RAM2 (6061 + reactive additive)", family: "Aluminium", process: "LPBF (3D Systems DMP Flex 350, XY)", condition: "Modified T6",
    Es_MPa: 69000, nu: 0.33, rho_kgm3: 2700, sigY0_MPa: 260, uts_MPa: 295, elong_pct: 16,
    voce: { sigSat_MPa: 365.8, delta: 10.06, Hlin_MPa: 0 }, ks_WmK: 162, muFluid_PaS: 0.001, crushSupported: true, source: "https://www.3dsystems.com/sites/default/files/2023-12/3d-systems-certified-a6061-ram2a-mds-letter-us-revc-web.pdf" },
  { id: "cocrmo-lpbf-asbuilt", name: "CoCrMo (F75-type, EOS MP1)", family: "Cobalt-chrome", process: "LPBF (EOS M290, 40 um)", condition: "As-built",
    Es_MPa: 180500, nu: 0.29, rho_kgm3: 8300, sigY0_MPa: 940, uts_MPa: 1285, elong_pct: 18,
    voce: { sigSat_MPa: 1571.8, delta: 14.45, Hlin_MPa: 0 }, ks_WmK: 14, muFluid_PaS: 0.001, crushSupported: true, source: "https://www.eos.info/05-datasheet-images/Assets_MDS_Metal/EOS_CobaltChrome_MP1/Material_DataSheet_EOS_CobaltChromeMP1_en.pdf" },
  { id: "cocrmo-lpbf-ht", name: "CoCrMo (F75-type, EOS MP1)", family: "Cobalt-chrome", process: "LPBF (EOS M290, 40 um)", condition: "Stress relieved + solution annealed",
    Es_MPa: 206500, nu: 0.29, rho_kgm3: 8300, sigY0_MPa: 635, uts_MPa: 1135, elong_pct: 30,
    voce: { sigSat_MPa: 1579.7, delta: 8.17, Hlin_MPa: 0 }, ks_WmK: 14, muFluid_PaS: 0.001, crushSupported: true, source: "https://www.eos.info/05-datasheet-images/Assets_MDS_Metal/EOS_CobaltChrome_MP1/Material_DataSheet_EOS_CobaltChromeMP1_en.pdf" },
  { id: "cocrmo-lpbf-hip", name: "CoCrMo (ASTM F75, 3DS LaserForm CoCrF75)", family: "Cobalt-chrome", process: "LPBF (3D Systems DMP)", condition: "HIP",
    Es_MPa: 225000, nu: 0.29, rho_kgm3: 8350, sigY0_MPa: 492.5, uts_MPa: 985, elong_pct: 26,
    voce: { sigSat_MPa: 1299.3, delta: 10.88, Hlin_MPa: 0 }, ks_WmK: 14, muFluid_PaS: 0.001, crushSupported: true, source: "https://3dsystems.com/sites/default/files/2017-03/3D-Systems_LaserForm_CoCrF75(A)_DATASHEET_USEN_2017.03.13_WEB.pdf" },
  { id: "ta-lpbf-asbuilt", name: "Tantalum (unalloyed)", family: "Refractory", process: "LPBF (research, Kustas et al. 2025)", condition: "As-built",
    Es_MPa: 186000, nu: 0.34, rho_kgm3: 16680, sigY0_MPa: 477.8, uts_MPa: 542, elong_pct: 20.7,
    voce: { sigSat_MPa: 736.4, delta: 6.04, Hlin_MPa: 0 }, ks_WmK: 57.5, muFluid_PaS: 0.001, crushSupported: true, source: "https://www.sciencedirect.com/science/article/pii/S2772369025000507" },
  { id: "nb-lpbf-asbuilt", name: "Niobium (unalloyed)", family: "Refractory", process: "LPBF (research, Griemsmann et al. 2021)", condition: "As-built",
    Es_MPa: 105000, nu: 0.4, rho_kgm3: 8580, sigY0_MPa: 324, uts_MPa: 525, elong_pct: 12,
    voce: { sigSat_MPa: 593.9, delta: 31.1, Hlin_MPa: 0 }, ks_WmK: 53.7, muFluid_PaS: 0.001, crushSupported: true, source: "https://link.springer.com/article/10.1007/s00170-021-06645-y" },
  { id: "grcop42-lpbf-hip", name: "GRCop-42 (Cu-Cr-Nb)", family: "Copper", process: "LPBF (Velo3D, vertical)", condition: "HIP",
    Es_MPa: 115000, nu: 0.34, rho_kgm3: 8790, sigY0_MPa: 185.8, uts_MPa: 378.3, elong_pct: 32.9,
    voce: { sigSat_MPa: 541.7, delta: 7.49, Hlin_MPa: 0 }, ks_WmK: 340, muFluid_PaS: 0.001, crushSupported: true, source: "https://velo3d.com/wp-content/uploads/2024/04/Velo3D-GRCop-42-Material-Datasheet.pdf" },
  { id: "cucrzr-lpbf-ht", name: "CuCrZr", family: "Copper", process: "LPBF (EOS M400-1)", condition: "Tensile-optimized heat treatment",
    Es_MPa: 122500, nu: 0.34, rho_kgm3: 8840, sigY0_MPa: 502.5, uts_MPa: 565, elong_pct: 18,
    voce: { sigSat_MPa: 729.6, delta: 7.77, Hlin_MPa: 0 }, ks_WmK: null, muFluid_PaS: 0.001, crushSupported: true, source: "https://www.eos.info/05-datasheet-images/Assets_MDS_Metal/EOS_CopperAlloy_CuCrZr/Material_DataSheet_EOS%20_Copper_CuCrZr_en.pdf" },
  { id: "pa12-sls", name: "PA12 (EOS PA 2200)", family: "Polymer", process: "SLS (EOS)", condition: "As-sintered, dry",
    Es_MPa: 1650, nu: 0.4, rho_kgm3: 930, sigY0_MPa: null, uts_MPa: 46, elong_pct: 13.3,
    voce: null, ks_WmK: null, muFluid_PaS: 0.001, crushSupported: false, source: "https://www.eos.info/polymer-solutions/polymer-materials/data-sheets/mds-pa-2200" },
  { id: "pa12-mjf", name: "PA12 (HP 3D HR PA 12)", family: "Polymer", process: "MJF (HP)", condition: "As-printed",
    Es_MPa: 1900, nu: 0.4, rho_kgm3: 1010, sigY0_MPa: null, uts_MPa: 50, elong_pct: 13,
    voce: null, ks_WmK: null, muFluid_PaS: 0.001, crushSupported: false, source: "https://info.sculpteo.com/hubfs/Material%20documentation/PA11%20HP/TDS%20HP%20pa12%20pa12gb%20pa11%20pp%20(1).pdf" },
  { id: "peek-sls", name: "PEEK (EOS PEEK HP3)", family: "Polymer", process: "HT-SLS (EOS P 800)", condition: "As-sintered (x/y)",
    Es_MPa: 4250, nu: 0.37, rho_kgm3: 1315, sigY0_MPa: null, uts_MPa: 90, elong_pct: 2.8,
    voce: null, ks_WmK: 0.29, muFluid_PaS: 0.001, crushSupported: false, source: "https://3dprinting.com/wp-content/uploads/2019/06/EOS-PEEK-HP3-Datasheet.pdf" },
  { id: "peek-fff", name: "PEEK (Victrex AM 450 FIL)", family: "Polymer", process: "FFF (heated chamber >=150 C)", condition: "As-printed, XY",
    Es_MPa: 3500, nu: 0.37, rho_kgm3: 1300, sigY0_MPa: 70, uts_MPa: 70, elong_pct: null,
    voce: { sigSat_MPa: 70, delta: 1, Hlin_MPa: 0 }, ks_WmK: 0.29, muFluid_PaS: 0.001, crushSupported: true, source: "https://www.victrex.com/-/media/downloads/datasheets/tds-am-450-fil.pdf" },
  { id: "pekk-sls", name: "PEKK (Arkema Kepstan, research)", family: "Polymer", process: "HT-SLS (Benedetti et al. 2019)", condition: "As-sintered",
    Es_MPa: 4300, nu: 0.4, nuFallback: true, rho_kgm3: null, sigY0_MPa: null, uts_MPa: 82.2, elong_pct: 2.4,
    voce: null, ks_WmK: null, muFluid_PaS: 0.001, crushSupported: false, source: "https://utw10945.utweb.utexas.edu/sites/default/files/2019/062%20Mechanical%20Performance%20of%20Laser%20Sintered%20Poly%28Ethe.pdf" },
  { id: "niti-lpbf", name: "NiTi (Nitinol)", family: "Shape memory", process: "LPBF", condition: "Any (superelastic or shape-memory)",
    Es_MPa: 78000, nu: 0.33, rho_kgm3: 6450, sigY0_MPa: null, uts_MPa: null, elong_pct: null,
    voce: null, ks_WmK: 18, muFluid_PaS: 0.001, crushSupported: false, source: "https://en.wikipedia.org/wiki/Nickel_titanium" }
];

function findMaterial(id) {
  for (var i = 0; i < F13LD_MATERIALS.length; i++) if (F13LD_MATERIALS[i].id === id) return F13LD_MATERIALS[i];
  return null;
}

/* Solver-facing material object (the recipe.material schema used by
   16b / 16c / 16f / 16g).  Returns null for 'recipe' or an unknown id. */
function materialForSolver(id) {
  var m = findMaterial(id);
  if (!m) return null;
  return {
    id: m.id, name: m.name,
    Es_MPa: m.Es_MPa, nu: m.nu,
    sigY0_MPa: m.sigY0_MPa,
    voce: m.voce ? { sigSat_MPa: m.voce.sigSat_MPa, delta: m.voce.delta, Hlin_MPa: m.voce.Hlin_MPa } : null,
    /* no Voce but a yield (e.g. PEEK FFF): perfectly plastic, not the 2000 MPa linear fallback */
    H_MPa: m.voce ? 2000 : 0,
    ks_WmK: m.ks_WmK, muFluid_PaS: m.muFluid_PaS,
    crushSupported: m.crushSupported
  };
}
