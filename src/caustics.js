import * as T from "three";

// D65 optical-density samples from the spectral catalog, indexed by path length in mm.
export const pathWeights = `
vec4 pathWeights(float mm){
  if(mm<1.)return vec4(mm,0.,0.,0.);
  if(mm<4.){float t=(mm-1.)/3.;return vec4(1.-t,t,0.,0.);}
  if(mm<12.){float t=(mm-4.)/8.;return vec4(0.,1.-t,t,0.);}
  float t=(mm-12.)/18.;return vec4(0.,0.,1.-t,t);
}`;

export function densities(gem) {
  // Guard the monotonicity of the RGB approximation at the edge of the sRGB gamut.
  const result = [];
  for (const row of gem.opticalDensity) {
    const d = new T.Vector3().fromArray(row);
    if (result.length) d.max(result[result.length - 1]);
    result.push(d);
  }
  return result;
}

export class CausticMap {
  constructor(renderer) {
    this.renderer = renderer;
    this.target = new T.WebGLRenderTarget(512, 512, {
      depthBuffer: false,
      type: renderer.extensions.has("EXT_color_buffer_float")
        ? T.HalfFloatType
        : T.UnsignedByteType,
    });
    this.uniforms = {
      atlas: { value: null },
      roles: { value: 1 },
      sector: { value: 0 },
      centerScale: { value: 1 },
      nativeAnchor: { value: new T.Vector2(0.5, 0.5) },
      centerAnchor: { value: new T.Vector2(0.5, 0.5) },
      gain: { value: 7 },
      family: { value: new T.Vector2() },
      sourceTint: { value: new T.Color(1, 1, 1) },
      density: { value: Array.from({ length: 8 }, () => new T.Vector3()) },
    };
    const material = new T.ShaderMaterial({
      uniforms: this.uniforms,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      vertexShader:
        "varying vec2 uv0;void main(){uv0=uv;gl_Position=vec4(position.xy,0.,1.);}",
      fragmentShader: `varying vec2 uv0;uniform sampler2D atlas;uniform float roles,sector,gain;uniform vec2 family,nativeAnchor,centerAnchor;uniform float centerScale;uniform vec3 sourceTint,density[8];
      ${pathWeights}
      vec3 sampleLight(float angle,float ior,int role){
        vec2 tile=vec2(3.*ior+mod(angle,3.),3.*float(role)+floor(angle/3.));
        vec2 uv=role==0?nativeAnchor+(uv0-centerAnchor)/centerScale:uv0;
        vec3 moments=texture2D(atlas,(tile+clamp(uv,.001,.999))/vec2(6.,3.*roles)).rgb;
        vec2 energy=(exp(moments.rg*6.240276)-1.)/32.;
        vec4 w=pathWeights(-5.*log(max(1.-moments.b,.001))*(role==0?centerScale:1.));
        int first=role*4;
        vec3 opticalDepth=density[first]*w.x+density[first+1]*w.y+density[first+2]*w.z+density[first+3]*w.w;
        return energy.x+energy.y*exp(-max(opticalDepth,vec3(0.)));
      }
      vec3 illuminate(float ior,int role){
        vec3 key=mix(sampleLight(floor(sector),ior,role),sampleLight(mod(floor(sector)+1.,8.),ior,role),fract(sector));
        return 1.2*sampleLight(8.,ior,role)+gain*sourceTint*key;
      }
      void main(){
        vec3 light=mix(illuminate(0.,0),illuminate(1.,0),family.x);
        if(roles>1.5) light+=mix(illuminate(0.,1),illuminate(1.,1),family.y);
        // Log packing also preserves caustic peaks on normalized render targets.
        gl_FragColor=vec4(log2(1.+light)/8.,1.);
      }`,
    });
    this.scene = new T.Scene();
    this.scene.add(new T.Mesh(new T.PlaneGeometry(2, 2), material));
    this.camera = new T.Camera();
  }
  setGems(gems, accents = []) {
    // Floor transport has a shared accent atlas. Mix transmission by stone area
    // when the individual shoulder stones have different materials.
    if (accents.length) {
      const area = accents.reduce((sum, a) => sum + a.area, 0);
      const mean = (fn) =>
        accents.reduce((sum, a) => sum + a.area * fn(a.gem), 0) / area;
      const mixed = {
        ior: mean((g) => g.ior),
        opticalDensity: gems[1].opticalDensity.map((row, i) =>
          row.map(
            (_, j) =>
              -Math.log(
                Math.max(
                  1e-9,
                  mean((g) => Math.exp(-g.opticalDensity[i][j])),
                ),
              ),
          ),
        ),
      };
      gems = [gems[0], mixed];
    }
    this.uniforms.density.value = gems.flatMap(densities);
    this.uniforms.family.value.fromArray(
      gems.map((g) => T.MathUtils.clamp((g.ior - 1.59) / 0.827, 0, 1)),
    );
    this.dirty = true;
  }
  update() {
    if (!this.dirty || !this.uniforms.atlas.value) return;
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.dirty = false;
  }
}
