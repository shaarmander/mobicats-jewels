use gemmo_core::{
    Cut, Gem, gems,
    jewelry::{Metal, RingDesign, StoneRole, build},
    spectra::{self, LampSpectrum},
};
use serde_json::{Value, json};
use std::{env, fs, path::Path};

const CUTS: [(Cut, &str); 18] = [
    (Cut::RoundBrilliant, "Round brilliant"),
    (Cut::EmeraldStep, "Emerald"),
    (Cut::OvalBrilliant, "Oval"),
    (Cut::Princess, "Princess"),
    (Cut::PearBrilliant, "Pear"),
    (Cut::CushionBrilliant, "Cushion"),
    (Cut::AsscherStep, "Asscher"),
    (Cut::MarquiseBrilliant, "Marquise"),
    (Cut::Radiant, "Radiant"),
    (Cut::BaguetteStep, "Baguette"),
    (Cut::TrillionBrilliant, "Trillion"),
    (Cut::Rose, "Rose"),
    (Cut::OldMine, "Old mine"),
    (Cut::OldEuropean, "Old European"),
    (Cut::HexagonStep, "Hexagon step"),
    (Cut::KiteStep, "Kite step"),
    (Cut::Portuguese, "Portuguese"),
    (Cut::Checkerboard, "Checkerboard"),
];
const SETTINGS: [(&str, &str); 18] = [
    ("solitaire", "Solitaire"),
    ("trilogy", "Three-stone"),
    ("pave", "Pavé"),
    ("cathedral", "Cathedral"),
    ("split", "Split shank"),
    ("eastwest", "East–west"),
    ("knife", "Knife edge"),
    ("dome", "Domed band"),
    ("cluster", "Pavé trilogy"),
    ("cable", "Cable twist"),
    ("ribbon", "Twisted ribbon"),
    ("wishbone", "Wishbone"),
    ("bypass", "Bypass"),
    ("interlace", "Interlace"),
    ("double", "Double rail"),
    ("marquise", "Marquise lattice"),
    ("fluted", "Fluted band"),
    ("petal", "Petal basket"),
];

fn write(path: &Path, value: Value) -> Result<(), Box<dyn std::error::Error>> {
    fs::write(path, serde_json::to_vec(&value)?)?;
    Ok(())
}
fn hex(c: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dest = env::args().nth(1).ok_or("missing output directory")?;
    let dest = Path::new(&dest);
    fs::create_dir_all(dest)?;
    let mut gem_list = Vec::new();
    for entry in gems::all() {
        let gem = Gem::generate(entry.recipe(74021, 1.0))?;
        let swatch = gems::body_colour(&gem, LampSpectrum::D65, 8.0);
        // Fit Beer-Lambert coefficients to D65 transmission over 4 mm. The
        // integral captures narrow absorption bands between RGB sample wavelengths.
        // Integrate the native absorption spectrum at several path lengths.
        // Optical density is interpolated per path in the web renderer.
        let norm = spectra::lamp_normalization_fractional(LampSpectrum::D65, 5.0);
        let white = spectra::xyz_to_linear_srgb(spectra::lamp_white_xyz(LampSpectrum::D65, 5.0));
        let depths = [1.0, 4.0, 12.0, 30.0];
        let densities: Vec<[f32;3]> = depths.iter().map(|mm| {
            let mut xyz = [0.0; 3];
            for (nm, w) in spectra::wavelengths_fractional(5.0) {
                let lamp = spectra::lamp_band_power(LampSpectrum::D65, nm, 5.0) * norm;
                let v = spectra::cie_xyz(nm) * (w * lamp * (-gem.absorption_at_nm(nm) * mm).exp());
                xyz[0]+=v.x; xyz[1]+=v.y; xyz[2]+=v.z;
            }
            let rgb=spectra::xyz_to_linear_srgb(xyz.into()).to_array();
            std::array::from_fn(|c| (-(rgb[c]/white.to_array()[c]).clamp(1e-8,1.0).ln()) as f32)
        }).collect();
        let absorp=densities[1].map(|v|v/4.);
        gem_list.push(json!({"id":entry.id,"name":entry.name,"family":entry.group,"ior":gem.optics.refractive_index_d,
            "dispersion":gem.optics.dispersion_bg,"density":gem.optics.density_g_cm3,"absorption":absorp,"opticalDensity":densities,
            "color":hex(swatch),"typicalCut":entry.cut.id()}));
    }
    let metal_ids = [
        "platinum",
        "white-gold",
        "yellow-gold",
        "yellow-gold-14k",
        "rose-gold",
        "silver",
        "palladium",
    ];
    let metals:Vec<_> = Metal::ALL.into_iter().zip(metal_ids).map(|(m,id)| json!({
        "id":id,"name":m.name(),"color":hex(m.swatch()),"density":m.density(),
        "reflectance":spectra::xyz_to_linear_srgb(m.xyz(LampSpectrum::D65)).to_array().map(|v|v.clamp(0.,1.))
    })).collect();
    write(
        &dest.join("library.json"),
        json!({
            "gems":gem_list,"metals":metals,"cuts":CUTS.map(|(cut,name)|json!({"id":cut.id(),"name":name})),
            "settings":SETTINGS.map(|(id,name)|json!({"id":id,"name":name})),
            "sizeUS":6,"colorModel":"Direction-averaged D65 transmission over 4 mm, swatches over 8 mm; reference-size settings"
        }),
    )?;
    for (setting, _) in SETTINGS {
        for (cut, _) in CUTS {
            let mut d = RingDesign::default();
            d.centre.recipe.apply_cut_defaults(cut);
            if !matches!(setting, "trilogy" | "cluster") {
                d.sides = None;
            }
            if !matches!(setting, "pave" | "cluster") {
                d.pave = None;
            }
            use gemmo_core::jewelry::ring::{Orientation, Profile};
            match setting {
                "ribbon" | "wishbone" | "bypass" => { d.head.prongs=Some(4); d.head.prong_mm=0.78; }
                "petal" => { d.head.culet_clearance_mm=1.35; d.head.prong_mm=0.76; }
                "eastwest" => {
                    d.centre.orientation = Orientation::EastWest;
                    d.band.profile = Profile::Flat;
                    d.band.width_top_mm = 3.5;
                    d.head.culet_clearance_mm = 0.28;
                }
                "knife" => {
                    d.band.profile = Profile::KnifeEdge;
                    d.band.width_top_mm = 3.6;
                    d.band.thickness_top_mm = 2.6;
                    d.head.prongs = Some(6);
                    d.head.prong_mm = 0.72;
                }
                "dome" => {
                    d.band.profile = Profile::DShape;
                    d.band.width_top_mm = 5.6;
                    d.band.width_back_mm = 3.7;
                    d.band.thickness_top_mm = 2.8;
                    d.head.culet_clearance_mm = 0.25;
                    d.head.prongs = Some(4);
                }
                "split" => { d.head.culet_clearance_mm = 1.1; }
                "cathedral" => { d.head.culet_clearance_mm = 1.95; d.head.prong_mm = 0.78; }
                "cluster" => {
                    d.band.width_top_mm = 2.9;
                    d.pave.as_mut().unwrap().coverage = 0.67;
                    d.sides.as_mut().unwrap().slot.recipe.carats = 0.26;
                }
                _ => {}
            }
            if let Some(ref mut sides) = d.sides {
                let side_cut = if matches!(cut, Cut::EmeraldStep | Cut::Princess) {
                    Cut::EmeraldStep
                } else {
                    Cut::RoundBrilliant
                };
                sides.slot.recipe.apply_cut_defaults(side_cut);
            }
            let m = build(&d)?;
            let parts: Vec<_> = m
                .parts
                .iter()
                .map(|p| {
                    json!({
                        "name":p.name,"vertices":p.mesh.positions,"triangles":p.mesh.triangles
                    })
                })
                .collect();
            let stones:Vec<_>=m.stones.iter().map(|s|{
                let role=match s.role {StoneRole::Centre=>"center", StoneRole::Side=>"side",StoneRole::Pave=>"pave"};
                let geometry=&s.gem.geometry;
                json!({"role":role,"rotation":s.rotation,"translation":s.translation,"scale":s.mm_per_unit(),
                    "cut":s.gem.recipe.cut.id(),"carats":s.carats(),
                    "facets":geometry.facets.iter().map(|f|json!({"vertices":f.vertices,"normal":f.normal})).collect::<Vec<_>>()})
            }).collect();
            write(
                &dest.join(format!("{setting}-{}.json", cut.id())),
                json!({"parts":parts,"stones":stones,
                "bounds":m.bounds(),"carats":m.total_carats(),"bandDiameter":m.inner_diameter_mm,"warnings":m.warnings}),
            )?;
        }
    }
    Ok(())
}
