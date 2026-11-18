import * as T from "three";

const resolution = 24;
const acceleration = new WeakMap();

// The ray starts inside a convex cut. If a plane still contains its far endpoint,
// it contains the entire segment. Each cell lists every plane that can exclude
// any point in the cell, including points on a facet boundary.
export function buildFacetGrid(positions, planes) {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  const diagonalLo = Array(4).fill(Infinity),
    diagonalHi = Array(4).fill(-Infinity);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i],
      y = positions[i + 1],
      z = positions[i + 2];
    for (let axis = 0; axis < 3; axis++) {
      lo[axis] = Math.min(lo[axis], positions[i + axis]);
      hi[axis] = Math.max(hi[axis], positions[i + axis]);
    }
    const d = [x + y, x - y, z + y, z - y];
    for (let j = 0; j < 4; j++) {
      diagonalLo[j] = Math.min(diagonalLo[j], d[j]);
      diagonalHi[j] = Math.max(diagonalHi[j], d[j]);
    }
  }
  // Expand the enclosing hull to account for mesh and facet-plane rounding.
  const pad = 0.001 * Math.max(...hi.map((v, i) => v - lo[i]));
  for (let i = 0; i < 3; i++) {
    hi[i] += pad;
    lo[i] -= pad;
  }
  for (let i = 0; i < 4; i++) {
    diagonalHi[i] += 2 * pad;
    diagonalLo[i] -= 2 * pad;
  }
  const step = hi.map((v, i) => (v - lo[i]) / resolution);
  const masks = new Uint32Array(4 * resolution ** 3);
  for (let face = 0; face < planes.length; face++) {
    const [nx, ny, nz, w] = planes[face];
    const corner =
      nx * lo[0] +
      ny * lo[1] +
      nz * lo[2] -
      w +
      pad +
      Math.max(0, nx * step[0]) +
      Math.max(0, ny * step[1]) +
      Math.max(0, nz * step[2]);
    const bit = 1 << (face % 32),
      word = face >> 5;
    for (let z = 0; z < resolution; z++)
      for (let y = 0; y < resolution; y++) {
        const start = corner + z * nz * step[2] + y * ny * step[1],
          dx = nx * step[0];
        const offset = (z * resolution + y) * resolution;
        // In a row of cells the half-space test is linear in X.
        const first = dx > 0 ? Math.max(0, Math.ceil(-start / dx)) : 0;
        const last =
          dx < 0
            ? Math.min(resolution - 1, Math.floor(-start / dx))
            : resolution - 1;
        if (dx === 0 && start < 0) continue;
        for (let x = first; x <= last; x++)
          masks[4 * (offset + x) + word] |= bit;
      }
  }
  return { masks, lo, hi, diagonalLo, diagonalHi, resolution };
}

export function facetUniforms(mesh) {
  const planes = mesh.userData.planes,
    geo = mesh.geometry;
  if (planes.length < 48 || planes.length > 128) return null;
  if (acceleration.has(geo)) return acceleration.get(geo);
  const positions = geo.getAttribute("position");
  if (
    positions.isInterleavedBufferAttribute ||
    positions.normalized ||
    positions.itemSize !== 3
  )
    return null;
  const data = buildFacetGrid(positions.array, planes);
  const r = data.resolution,
    texture = new T.Data3DTexture(data.masks, r, r, r);
  texture.format = T.RGBAIntegerFormat;
  texture.type = T.UnsignedIntType;
  texture.internalFormat = "RGBA32UI";
  texture.minFilter = texture.magFilter = T.NearestFilter;
  texture.needsUpdate = true;
  const uniforms = {
    facetMasks: { value: texture },
    boxLo: { value: new T.Vector3(...data.lo) },
    boxHi: { value: new T.Vector3(...data.hi) },
    diagLo: { value: new T.Vector4(...data.diagonalLo) },
    diagHi: { value: new T.Vector4(...data.diagonalHi) },
  };
  acceleration.set(geo, uniforms);
  geo.addEventListener("dispose", () => {
    texture.dispose();
    acceleration.delete(geo);
  });
  return uniforms;
}

export const exitQuery = `
#ifdef FACET_GRID
uniform highp usampler3D facetMasks;
uniform vec3 boxLo,boxHi;
uniform vec4 diagLo,diagHi;
uvec4 candidates(vec3 p,vec3 dir){
  vec3 positive=step(vec3(0.),dir);
  vec3 t=(mix(boxLo,boxHi,positive)-p)*mix(vec3(-1.),vec3(1.),positive)/max(abs(dir),vec3(1e-15));
  vec4 slant=vec4(1.,-1.,1.,-1.);
  vec4 d=dir.xxzz+slant*dir.y, origin=p.xxzz+slant*p.y;
  vec4 sign4=step(vec4(0.),d);
  vec4 td=(mix(diagLo,diagHi,sign4)-origin)*mix(vec4(-1.),vec4(1.),sign4)/max(abs(d),vec4(1e-15));
  float upper=min(min(t.x,min(t.y,t.z)),min(min(td.x,td.y),min(td.z,td.w)));
  vec3 uv=(p+max(upper,0.)*dir-boxLo)/(boxHi-boxLo);
  ivec3 size=textureSize(facetMasks,0);
  return texelFetch(facetMasks,clamp(ivec3(uv*vec3(size)),ivec3(0),size-1),0);
}
#endif

void testPlane(int i, vec3 p, vec3 dir, inout float numBest, inout float denBest, inout int face){
  vec4 plane=planes[i];
  float den=dot(plane.xyz,dir),num=plane.w-dot(plane.xyz,p);
  if(den>1e-6 && num>.000008*den && num*denBest<numBest*den){
    numBest=num; denBest=den; face=i;
  }
}
float nextFacet(vec3 p, vec3 dir, out int face){
  float numerator=1e7,denominator=1.;
  face=0;
  #ifdef FACET_GRID
    uvec4 bits=candidates(p,dir);
    for(int group=0;group<4;group++){
      uint word=bits[group];
      while(word!=0u){
        // An isolated bit is an exact power of two. Read its exponent in GLSL ES 3.0.
        uint low=word&(~word+1u);
        int i=group*32+int(floatBitsToUint(float(low))>>23u)-127;
        testPlane(i,p,dir,numerator,denominator,face);
        word&=word-1u;
      }
    }
    if(numerator<1e7)return numerator/denominator;
  #endif
  // Small cuts use the direct scan. Also handle a numerically outlying ray.
  for(int i=0;i<PLANE_COUNT;i++)testPlane(i,p,dir,numerator,denominator,face);
  return numerator/denominator;
}
`;
