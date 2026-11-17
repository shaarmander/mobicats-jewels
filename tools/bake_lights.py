"""Bake Y-up panoramic jewelry lighting from Gemmo's native Studio light panels.

python tools/bake_lights.py PATH_TO_GEMMO_STUDIO [--review-dir DIRECTORY]
The optional review includes decoded HDR statistics and identical material probes.
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

W, H = 4096, 2048
HERE = Path(__file__).resolve().parents[1]
DEST = HERE / "public" / "assets" / "lights"
LUMA = np.array([.2126, .7152, .0722])
RIGS = [
    ("softbox", "Studio softbox", "studio", 0.0, .98, "#b3b1a6", "#e1e2da"),
    ("spotlights", "Jewelry spotlights", "store-spotlights", -.18, 1.00, "#868a90", "#b9bfc7"),
    ("gallery", "Warm gallery", "warm-indoor", .14, .96, "#b2a597", "#d9cec0"),
    ("darkfield", "Darkfield", "darkfield", .0, 1.07, "#25282c", "#363a40"),
]


def unit(x):
    x = np.asarray(x, dtype=np.float32)
    return x / np.maximum(np.linalg.norm(x, axis=-1, keepdims=True), 1e-12)


def dot(dirs, v):
    return dirs[..., 0]*v[0] + dirs[..., 1]*v[1] + dirs[..., 2]*v[2]


def smooth(x):
    x = np.clip(x, 0., 1.)
    return x*x*(3.-2.*x)


def sky_rays(dx, dy, row=0, end=None):
    # Matches Three's equirectUv: u = atan2(z, x)/(2*pi) + 0.5.
    lon = ((np.arange(W, dtype=np.float32)+dx)/W-.5)*(2*np.pi)
    lat = (.5-(np.arange(row, H if end is None else end, dtype=np.float32)+dy)/H)*np.pi
    x = np.cos(lat)[:, None]*np.cos(lon)
    z = np.cos(lat)[:, None]*np.sin(lon)
    return np.stack((x, np.broadcast_to(np.sin(lat)[:, None], x.shape), z), axis=-1)


def native_sources(dirs, lights, rig):
    distance = np.full(dirs.shape[:2], np.inf, dtype=np.float32)
    result = np.zeros_like(dirs)
    for light in lights:
        center = np.asarray(light["center"], dtype=np.float32)
        n = unit(light["facing"])
        u = unit(np.cross(n, [0, 0, 1] if abs(n[1]) > .99 else [0, 1, 0]))
        v = np.cross(n, u)
        denominator = dot(dirs, n)
        t = np.dot(center, n)/np.minimum(denominator, -.000001)
        half = np.asarray(light["half_size"], dtype=np.float32)
        intensity = light["radiance"]
        color = np.ones(3, dtype=np.float32)
        local_spot = rig == "spotlights" and intensity > 100
        if local_spot:
            # Keep seven native spot directions. A wider finite aperture survives
            # low-resolution prefiltering and peak limiting controls display glare.
            half *= 2.6
            intensity = 70.
            color = np.array([1., .92, .78])
        elif rig == "gallery" and intensity > 10.:
            intensity = 15.
            color = np.array([1., .70, .43])
        elif rig == "darkfield":
            color = np.array([.89, .95, 1.0])
        x = ((dot(dirs, u)*t)-np.dot(center,u))/half[0]
        y = ((dot(dirs, v)*t)-np.dot(center,v))/half[1]
        hit = (denominator < -.00001) & (t > 0) & (abs(x) <= 1.) & (abs(y) <= 1.)
        soft = light["soft_edge"]
        if local_spot:
            profile = smooth((1.-np.sqrt(x*x+y*y))/.65)
        elif soft > 0:
            profile = smooth((1.-abs(x))/soft)*smooth((1.-abs(y))/soft)
        else:
            profile = np.ones_like(x)
        value = (intensity*profile)[..., None]*color
        previous = distance.copy()
        near = hit & (t < previous-.001)
        same = hit & (abs(t-previous) <= .001)
        result[near] = value[near]
        result[same] += value[same]
        distance[near] = t[near]
    return result


def card(dirs, azimuth, elevation, width, height, roll, feather):
    az, el, roll, w, h = np.deg2rad([azimuth, elevation, roll, width/2, height/2])
    center = np.array([np.cos(el)*np.cos(az),np.sin(el),np.cos(el)*np.sin(az)])
    right = np.array([-np.sin(az),0,np.cos(az)])
    up = np.cross(right, center)
    u = right*np.cos(roll)+up*np.sin(roll)
    v = up*np.cos(roll)-right*np.sin(roll)
    den = np.maximum(.0001,dot(dirs,center))
    x = abs(dot(dirs,u)/den)/np.tan(w)
    y = abs(dot(dirs,v)/den)/np.tan(h)
    return smooth((1.-x)/feather)*smooth((1.-y)/feather)*(dot(dirs,center) > 0.)


# (azimuth, elevation, width, height, roll, edge feather), linear RGB radiance.
# Negative fills are opaque flags, so they attenuate the sources behind them.
MODIFIERS = {
    "softbox": [
        ((135,35,64,53,-14,.23), (3.8,3.72,3.56)),
        ((-36,22,12,89,6,.32), (3.35,3.55,3.70)),
        ((-116,31,42,78,-5,.12), .11),
        ((37,15,23,85,-7,.17), .045),
        ((107,24,3.3,69,-8,.35), (2.4,2.38,2.29)),
        ((-19,58,3.2,3.2,0,.65),(32.,30.,27.)),
        ((67,31,2.5,2.5,0,.65),(26.,27.,32.)),
    ],
    "spotlights": [
        ((146,20,56,60,-15,.34), (1.15,1.18,1.23)),
        ((-21,28,8.5,91,15,.25), (3.1,3.18,3.43)),
        ((-102,20,35,78,-10,.17), .09),
        ((45,30,20,63,4,.22), .18),
    ],
    "gallery": [
        ((151,25,40,78,-7,.36), (3.25,2.22,1.53)),
        ((-64,22,12,80,15,.25), (1.50,1.64,2.02)),
        ((-118,16,46,63,-15,.24), .10),
        ((18,12,15,75,-7,.18), .16),
        ((84,68,5,6,-8,.75), (14.,10.,6.2)),
    ],
    "darkfield": [
        ((136,30,20,65,-22,.32), (1.68,1.96,2.2)),
        ((-42,32,5.5,64,18,.28), (2.68,2.86,3.12)),
        ((30,3,21,33,5,.13), .09),
        ((-125,5,29,27,-8,.24), .10),
        ((80,61,4.2,4.2,0,.70), (12.,11.8,11.45)),
    ],
}


def bake(dirs, lights, rig):
    source = native_sources(dirs, lights, rig)
    y = dirs[...,1]
    if rig == "softbox":
        surround, floor = (.09,.095,.097), (.62,.62,.60)
    elif rig == "spotlights":
        surround, floor = (.045,.05,.058), (.39,.40,.42)
    elif rig == "gallery":
        surround, floor = (.074,.057,.048), (.53,.47,.40)
    else:
        surround, floor = (.055,.062,.070), (.14,.15,.16)
    env = source + np.array(surround,dtype=np.float32)
    # A sweep under the object gives reflective metals a continuous lower arc.
    # Darkfield's horizon emitters remain visible slightly below horizontal.
    floor_weight = smooth((-y-.055)/.24)
    grad = 0.78+.22*np.maximum(0,-y)
    # A broad pool of counter light and a distant negative fill give the lower
    # hemisphere a gradual directional structure under the band and prongs.
    pool_dir = unit([-.56,-.60,.59])
    flag_dir = unit([.69,-.25,-.68])
    gradient = .72 + .44 * np.maximum(0,dot(dirs,pool_dir))**2 - .20*np.maximum(0,dot(dirs,flag_dir))**3
    base_floor = np.asarray(floor)*(grad*gradient)[...,None]
    env = env*(1.-floor_weight[...,None])+base_floor*floor_weight[...,None]
    # Compact jewelry pin lights create brief, angular flashes when a real
    # facet lines up with an emitter. Negative-fill cards can still occlude them.
    pins = [(-68,44,2.2),(18,62,1.9),(73,24,2.5),(154,49,2.0),(-144,19,1.7),(109,72,2.3)]
    pin_radiance = {"softbox":48,"spotlights":95,"gallery":33,"darkfield":47}[rig]
    pin_color=np.array((1.,.82,.59) if rig=="gallery" else (1.,.98,.96))
    for az,el,diameter in pins:
        env+=card(dirs,az,el,diameter,diameter,45,.45)[...,None]*pin_radiance*pin_color
    for spec, value in MODIFIERS[rig]:
        mask=card(dirs,*spec)[...,None]
        if isinstance(value,float):
            env*=1.-mask*(1.-value)
        else:
            env+=mask*np.asarray(value)
    return env


def display(rgb,exposure):
    # ACES filmic fit and sRGB encoding for the diagnostic contact sheet.
    v = rgb*exposure
    mapped = np.clip(v*(2.51*v+.03)/(v*(2.43*v+.59)+.14),0,1)
    gamma = np.where(mapped<=.0031308,12.92*mapped,1.055*np.power(mapped,1/2.4)-.055)
    return Image.fromarray(np.uint8(np.clip(gamma*255+.5,0,255)))


def sample_map(panorama,d):
    u = np.arctan2(d[...,2],d[...,0])/(2*np.pi)+.5
    v = .5-np.arcsin(np.clip(d[...,1],-1,1))/np.pi
    return cv2.remap(panorama,(u*W-.5).astype('float32'), (v*H-.5).astype('float32'),
                     cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)


def previews(panorama, exposure):
    q = np.linspace(-1.12,1.12,180,dtype=np.float32)
    x,y = np.meshgrid(q,-q)
    r2 = x*x+y*y
    z = np.sqrt(np.maximum(0.,1.-r2))
    normal=np.stack((x,y,z),axis=-1)
    rays=unit(normal*2*z[...,None]-[0,0,1])
    mask=r2<1
    metal=sample_map(panorama,rays)
    for tint in [(1.,1.,1.),(.95,.68,.28)]:
        pixels=np.where(mask[...,None],metal*np.asarray(tint),.15)
        yield display(pixels,exposure)


def refract(ray, normal, eta):
    c = -np.sum(ray*normal,axis=-1,keepdims=True)
    cos2 = 1-eta**2*(1-c*c)
    return unit(eta*ray + (eta*c-np.sqrt(np.maximum(cos2,0)))*normal),cos2[:,0]>=0


def gem_probe(stone, panorama, exposure):
    # Same cut geometry in every environment. Trace three bands independently
    # for this offline contact sheet so the lighting's effect on fire is visible.
    dim=180
    normals=np.array([f["normal"] for f in stone["facets"]],dtype=np.float32)
    h=np.array([f["distance"] for f in stone["facets"]],dtype=np.float32)
    camera=stone["camera"]; yaw=np.deg2rad(190); pitch=camera["pitch"]
    out=unit([np.sin(yaw)*np.cos(pitch),np.sin(pitch),np.cos(yaw)*np.cos(pitch)])
    right=unit([np.cos(yaw),0,-np.sin(yaw)])
    up=np.cross(out,right)
    eye=np.asarray(camera["target"])+camera["distance"]*out
    coord=(np.arange(dim,dtype=np.float32)+.5)*2/dim-1
    x,y=np.meshgrid(coord,-coord)
    ray=unit(-out+camera["tanHalfFov"]*(x[...,None]*right+y[...,None]*up)).reshape(-1,3)
    den=ray@normals.T; nom=h-np.dot(eye,normals.T)
    depth=nom/np.where(abs(den)>1e-7,den,1e-7)
    near=np.where(den<0,depth,-1e9); far=np.where(den>0,depth,1e9)
    facet=near.argmax(1); first=near.max(1); mask=(first>0)&(first<=far.min(1))
    n=normals[facet[mask]]; ray=ray[mask]
    pos=(eye+first[mask,None]*ray).astype(np.float32)
    main_reflect=unit(ray-2*np.sum(ray*n,1)[:,None]*n)
    def lookup(d):
        return sample_map(panorama,d[:,None,:]).reshape(-1,3)
    entry=np.maximum(0,-np.sum(ray*n,axis=1)); f0=.172
    fres=f0+(1-f0)*(1-entry)**5
    rgb=lookup(main_reflect)*fres[:,None]
    for ch,ior in enumerate([2.412,2.422,2.451]):
        direction,_=refract(ray,n,1/ior);origin=pos.copy();weight=1-fres
        for bounce in range(9):
            den=direction@normals.T
            t=(h-origin@normals.T)/np.where(den>1e-6,den,1)
            t=np.where((den>1e-6)&(t>5e-6),t,1e8)
            next_facet=t.argmin(1); dist=t[np.arange(len(t)),next_facet]
            normal=normals[next_facet]
            origin+=dist[:,None]*direction
            outside,escape=refract(direction,-normal,ior)
            cosine=np.maximum(0,np.sum(direction*normal,axis=1))
            exit_fres=f0+(1-f0)*(1-cosine)**5
            transmission=np.where(escape,1-exit_fres,0)
            rgb[:,ch]+=weight*transmission*lookup(outside)[:,ch]
            weight*=1-transmission
            direction=unit(direction-2*np.sum(direction*normal,1)[:,None]*normal)
        rgb[:,ch]+=weight*.2
    img=np.full((dim*dim,3),.15,dtype=np.float32)
    img[mask]=rgb
    return display(img.reshape(dim,dim,3),exposure)


def review_stats(panorama):
    lum=panorama@LUMA
    weights=np.broadcast_to(np.sin((np.arange(H)+.5)*np.pi/H)[:,None],(H,W))
    idx=np.argsort(lum.ravel()); ordered=lum.ravel()[idx]
    area=np.cumsum(weights.ravel()[idx]);area/=area[-1]
    quant=np.interp([.1,.5,.9,.99],area,ordered)
    return dict(mean=round(float(np.average(lum,weights=weights)),4),
                max=round(float(lum.max()),4),
                p10_p50_p90_p99=np.round(quant,4).tolist(),
                brightest_percent_area_above_4=round(float(100*np.average(lum>4,weights=weights)),4))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("studio",type=Path)
    parser.add_argument("--review-dir",type=Path)
    parser.add_argument("--review-gem",type=Path,help="Optional Studio stone.json to render beside the metal probes")
    args=parser.parse_args()
    DEST.mkdir(parents=True,exist_ok=True)
    if args.review_dir:
        args.review_dir.mkdir(parents=True,exist_ok=True)
        sheet=Image.new("RGB",(970 if args.review_gem else 770,4*224),"#f0eee8")
        draw=ImageDraw.Draw(sheet)
        try: title=ImageFont.truetype("segoeui.ttf",20)
        except OSError: title=ImageFont.load_default()
    manifest=[]; stats={}
    for row,(key,name,source,rotation,exposure,stage,bg) in enumerate(RIGS):
        preset=json.loads((args.studio/"presets"/"lighting"/(source+".json")).read_text())
        panorama=np.zeros((H,W,3),dtype=np.float32)
        for row0 in range(0,H,128):
            row1=min(row0+128,H)
            for dy in [.25,.75]:
                for dx in [.25,.75]:
                    panorama[row0:row1]+=bake(sky_rays(dx,dy,row0,row1),preset["lights"],key)*.25
        f=DEST/(key+".hdr")
        if not cv2.imwrite(str(f),np.ascontiguousarray(panorama[...,::-1])): raise OSError(f)
        decoded=cv2.imread(str(f),cv2.IMREAD_UNCHANGED)[...,::-1]
        assert decoded.shape==(H,W,3) and np.isfinite(decoded).all() and decoded.max()>4
        assert abs((decoded@LUMA).mean()/(panorama@LUMA).mean()-1)<.011
        compact=DEST/(key+"-compact.hdr")
        cv2.imwrite(str(compact),cv2.resize(decoded[...,::-1],(2048,1024),interpolation=cv2.INTER_AREA))
        manifest.append(dict(id=key,name=name,environment="/assets/lights/"+f.name,compactEnvironment="/assets/lights/"+compact.name,
                             rotationY=rotation,exposure=exposure,stageColor=stage,backgroundColor=bg))
        if args.review_dir:
            stats[key]={"file_bytes":f.stat().st_size,**review_stats(decoded)}
            top=row*224
            draw.text((10,top+2),name,fill="#182820",font=title)
            sheet.paste(display(decoded,exposure).resize((360,180)),(10,top+33))
            for i,probe in enumerate(previews(decoded,exposure)):
                sheet.paste(probe,(390+i*200,top+33))
            if args.review_gem:
                sheet.paste(gem_probe(json.loads(args.review_gem.read_text()),decoded,exposure),(790,top+33))
            print(name,stats[key],flush=True)
    (DEST/"lights.json").write_text(json.dumps(manifest,indent=2)+"\n",encoding="utf-8")
    if args.review_dir:
        sheet.save(args.review_dir/"lighting-contact.jpg",quality=94)
        (args.review_dir/"luminance.json").write_text(json.dumps(stats,indent=2)+"\n",encoding="utf-8")


if __name__ == "__main__":
    main()
