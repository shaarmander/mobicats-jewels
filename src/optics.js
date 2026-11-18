import * as T from "three";
import { densities, pathWeights } from "./caustics.js";

// A rasterized front facet seeds a bounded path in the stone's own coordinate system.
// The local reflection probe contains the actual setting, shank and studio lights.
export function setStoneOptics(material, gem) {
  const b = gem.dispersion / (1 / 0.4308 ** 2 - 1 / 0.6867 ** 2);
  const indices = [0.61, 0.55, 0.46].map(
    (w) => gem.ior + b * (1 / w ** 2 - 1 / 0.5893 ** 2),
  );
  material.uniforms.indices.value.fromArray(indices);
  material.uniforms.density.value = densities(gem);
}
export function cutMaterial(mesh, center, probe) {
  const planes = mesh.userData.planes.map((p) => new T.Vector4(...p));
  const uniforms = {
    planes: { value: planes },
    indices: { value: new T.Vector3() },
    density: { value: Array.from({ length: 4 }, () => new T.Vector3()) },
    mmPerUnit: { value: mesh.userData.mmPerUnit },
    localEye: { value: new T.Vector3() },
    probe: { value: probe },
    worldAxes: { value: new T.Matrix3() },
  };
  return new T.ShaderMaterial({
    uniforms,
    defines: { PLANE_COUNT: planes.length, PATH_LIMIT: center ? 18 : 7 },
    vertexShader: `
      varying vec3 pObject; varying vec3 facet;
      void main(){pObject=position; facet=normal;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}
    `,
    fragmentShader: `
      varying vec3 pObject; varying vec3 facet;
      uniform vec4 planes[PLANE_COUNT];
      uniform vec3 indices,density[4],localEye;
      ${pathWeights}
      uniform float mmPerUnit;
      uniform mat3 worldAxes;
      uniform samplerCube probe;
      float fresnel(float c,float a,float b){
        float s=(a*a)/(b*b)*max(0.,1.-c*c);
        if(s>=1.)return 1.;
        float t=sqrt(1.-s);
        vec2 k=vec2(a*c,b*c), m=vec2(b*t,a*t);
        vec2 r=(k-m)/max(k+m,vec2(.00001));return dot(r,r)*.5;
      }
      // Compute a fixed footprint per optical ray. Derivatives across a facet
      // discontinuity would average unrelated directions into a dark rim.
      vec3 lightAt(vec3 d){
        vec3 world=normalize(worldAxes*d);
        float cameraFlag=smoothstep(.86,.975,dot(world,normalize(worldAxes*(localEye-pObject))));
        return textureLod(probe,world,.35).rgb*(1.-.87*cameraFlag);
      }
      float transport(vec3 incident,vec3 entryNormal,float ior,vec4 depth,vec3 channel){
        float c=clamp(-dot(incident,entryNormal),0.,1.);
        float reflected=fresnel(c,1.,ior);
        float result=reflected*dot(lightAt(reflect(incident,entryNormal)),channel);
        float throughput=1.-reflected, pathMm=0.;
        vec3 dir=refract(incident,entryNormal,1./ior), p=pObject;
        for(int step=0;step<PATH_LIMIT;step++){
          float numerator=1e7,denominator=1.;int face=0;
          for(int i=0;i<PLANE_COUNT;i++){
            vec4 plane=planes[i];
            float den=dot(plane.xyz,dir),num=plane.w-dot(plane.xyz,p);
            if(den>1e-6 && num>.000008*den && num*denominator<numerator*den){
              numerator=num;denominator=den;face=i;
            }
          }
          float length=numerator/denominator;
          if(length>1e5)break;
          p+=dir*length;
          pathMm+=length*mmPerUnit;
          float surviving=throughput*exp(-dot(depth,pathWeights(pathMm)));
          vec3 n=planes[face].xyz;
          float cosine=clamp(dot(dir,n),0.,1.);
          reflected=fresnel(cosine,ior,1.);
          if(reflected<.99999){
            vec3 exitDir=refract(dir,-n,ior);
            result+=surviving*(1.-reflected)*dot(lightAt(exitDir),channel);
          }
          throughput*=reflected;
          if(surviving*reflected<.002)return result;
          dir=reflect(dir,n);
        }
        return result+throughput*.32*exp(-dot(depth,pathWeights(pathMm+mmPerUnit*2.5)))*dot(lightAt(dir),channel);
      }
      void main(){
        vec3 n=normalize(facet),incident=normalize(pObject-localEye);
        vec3 result=vec3(
          transport(incident,n,indices.r,vec4(density[0].r,density[1].r,density[2].r,density[3].r),vec3(1,0,0)),
          transport(incident,n,indices.g,vec4(density[0].g,density[1].g,density[2].g,density[3].g),vec3(0,1,0)),
          transport(incident,n,indices.b,vec4(density[0].b,density[1].b,density[2].b,density[3].b),vec3(0,0,1)));
        gl_FragColor=vec4(result,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// Parallel off-axis camera views converge at the picked focus plane. Accumulate
// radiance before tone mapping, so occlusion, specular highlights and transparent
// facets all respond to the lens opening.
export class Lens {
  constructor(renderer, camera) {
    this.renderer = renderer;
    this.camera = camera;
    this.eye = camera.clone();
    this.float = renderer.extensions.has("EXT_color_buffer_float");
    const type = this.float ? T.HalfFloatType : T.UnsignedByteType;
    this.view = new T.WebGLRenderTarget(1, 1, {
      type,
      depthBuffer: true,
      samples: Math.min(2, renderer.capabilities.maxSamples),
    });
    this.sum = new T.WebGLRenderTarget(1, 1, { type, depthBuffer: false });
    this.size = new T.Vector2();
    this.minimumSize = new T.Vector2(1, 1);
    this.axisX = new T.Vector3();
    this.axisY = new T.Vector3();
    this.scene = new T.Scene();
    this.ortho = new T.Camera();
    const vertexShader =
      "varying vec2 uv0; void main(){uv0=uv;gl_Position=vec4(position.xy,0.,1.);}";
    // The moving lens needs one shaded view. Its depth gives the signed radius
    // of the aperture disk in pixels; samples on a distant plane cannot wash
    // over an in-focus prong. The idle lens still sees behind that prong.
    this.previewView = new T.WebGLRenderTarget(1, 1, {
      type,
      depthTexture: new T.DepthTexture(1, 1, T.UnsignedIntType),
    });
    this.preview = new T.WebGLRenderTarget(1, 1, { type, depthBuffer: false });
    this.bokeh = new T.ShaderMaterial({
      vertexShader,
      toneMapped: false,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        frame: { value: this.previewView.texture },
        depth: { value: this.previewView.depthTexture },
        coc: { value: new T.Vector2() },
      },
      fragmentShader: `varying vec2 uv0;
        uniform sampler2D frame,depth;
        uniform vec2 coc;
        float radius(vec2 uv){return dot(vec2(texture2D(depth,uv).r,1.),coc);}
        void main(){
          vec2 px=1./vec2(textureSize(frame,0));
          float center=radius(uv0);
          vec3 sharp=texture2D(frame,uv0).rgb;
          float reach=min(abs(center),22.);
          if(reach<.55){gl_FragColor=vec4(sharp,1.);return;}
          vec3 sum=sharp;float weights=1.;
          vec2 axis=vec2(1.,0.);
          for(int i=0;i<24;i++){
            float distance=reach*sqrt((float(i)+.5)/24.);
            vec2 uv=uv0+px*axis*distance;
            float r=radius(uv);
            float w=smoothstep(distance-.8,distance+.8,abs(r));
            // Positive radii are in front of the focus plane.
            w*=1.-smoothstep(1.,3.,center-r);
            sum+=texture2D(frame,uv).rgb*w;weights+=w;
            axis=mat2(-.737369,.675490,-.675490,-.737369)*axis;
          }
          gl_FragColor=vec4(mix(sharp,sum/weights,smoothstep(.55,1.4,reach)),1.);
        }`,
    });
    this.add = new T.ShaderMaterial({
      vertexShader,
      uniforms: { frame: { value: this.view.texture }, weight: { value: 1 } },
      fragmentShader:
        "varying vec2 uv0;uniform sampler2D frame;uniform float weight;void main(){gl_FragColor=vec4(texture2D(frame,uv0).rgb*weight,1.);}",
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: T.CustomBlending,
      blendSrc: T.OneFactor,
      blendDst: T.OneFactor,
      blendEquation: T.AddEquation,
      toneMapped: false,
    });
    this.sparkle = 0.65;
    this.peaks = new T.WebGLRenderTarget(1, 1, { type, depthBuffer: false });
    this.rays = new T.WebGLRenderTarget(1, 1, { type, depthBuffer: false });
    this.extract = new T.ShaderMaterial({
      vertexShader,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      uniforms: {
        frame: { value: null },
        weight: { value: 1 },
        threshold: { value: 2.25 },
      },
      fragmentShader: `varying vec2 uv0;
      uniform sampler2D frame;
      uniform float weight,threshold;
      void main(){
        ivec2 size=textureSize(frame,0);
        vec2 center=uv0*vec2(size)-.5;
        ivec2 start=ivec2(floor(center))-2;
        vec3 energy=vec3(0.);
        float knee=threshold*.4;
        // Overlapping tents share each source pixel between neighboring glints.
        // Extract its HDR energy before downsampling so a small facet survives.
        for(int y=0;y<6;y++){
          for(int x=0;x<6;x++){
            ivec2 pixel=start+ivec2(x,y);
            vec2 tent=max(vec2(0.),1.-abs(vec2(pixel)-center)/3.);
            vec3 color=texelFetch(frame,clamp(pixel,ivec2(0),size-1),0).rgb*weight;
            float luminance=dot(color,vec3(.24,.61,.15));
            float shoulder=clamp(luminance-threshold+knee,0.,2.*knee);
            float excess=max(luminance-threshold,shoulder*shoulder/(4.*knee));
            energy+=tent.x*tent.y*color*(min(excess,22.)/max(luminance,.0001));
          }
        }
        gl_FragColor=vec4(energy/9.,1.);
      }`,
    });
    this.diffraction = new T.ShaderMaterial({
      vertexShader,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      uniforms: {
        peaks: { value: this.peaks.texture },
        stepUV: { value: new T.Vector2() },
      },
      fragmentShader: `varying vec2 uv0;uniform sampler2D peaks;uniform vec2 stepUV;
      void main(){
        vec3 rays=vec3(0.);
        for(int axis=0;axis<3;axis++){
          float ang=.20+float(axis)*1.04719755;
          vec2 stepDir=vec2(cos(ang),sin(ang))*stepUV;
          for(int j=1;j<=8;j++){
            float n=float(j);vec2 v=stepDir*n;
            rays+=(texture2D(peaks,uv0+v).rgb+texture2D(peaks,uv0-v).rgb)*exp(-n*.38);
          }
        }
        gl_FragColor=vec4(rays*.128,1.);
      }`,
    });
    this.resolve = new T.ShaderMaterial({
      vertexShader,
      uniforms: {
        frame: { value: this.sum.texture },
        weight: { value: 1 },
        rays: { value: this.rays.texture },
        sparkle: { value: 0 },
        edgeAA: { value: false },
      },
      fragmentShader: `varying vec2 uv0;uniform sampler2D frame,rays;uniform float weight,sparkle;
      uniform bool edgeAA;
      float perceived(vec3 c) {
        float light=dot(c,vec3(.2126,.7152,.0722));
        return sqrt(light/(1.+light));
      }
      vec3 resolveEdge(vec3 center){
        vec2 px=1./vec2(textureSize(frame,0));
        float nw=perceived(texture2D(frame,uv0+px*vec2(-1.,1.)).rgb);
        float ne=perceived(texture2D(frame,uv0+px).rgb);
        float sw=perceived(texture2D(frame,uv0-px).rgb);
        float se=perceived(texture2D(frame,uv0+px*vec2(1.,-1.)).rgb);
        float mid=perceived(center), lo=min(mid,min(min(nw,ne),min(sw,se)));
        float hi=max(mid,max(max(nw,ne),max(sw,se)));
        if(hi-lo < max(.025,hi*.075))return center;
        vec2 edge=vec2(-(nw+ne-sw-se),nw+sw-ne-se);
        float scale=min(abs(edge.x),abs(edge.y)) + max(.025,(nw+ne+sw+se)*.025);
        vec2 along=clamp(edge/scale,vec2(-4.),vec2(4.))*px;
        vec3 inner=.5*(texture2D(frame,uv0-along/6.).rgb+texture2D(frame,uv0+along/6.).rgb);
        vec3 wider=.5*inner+.25*(texture2D(frame,uv0-along*.5).rgb+texture2D(frame,uv0+along*.5).rgb);
        float l=perceived(wider);
        return mix(center,l<lo || l>hi?inner:wider,.8);
      }
      void main(){
        vec3 color=texture2D(frame,uv0).rgb;
        if(edgeAA)color=resolveEdge(color);
        gl_FragColor=vec4(color*weight+sparkle*texture2D(rays,uv0).rgb,1.);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new T.Mesh(new T.PlaneGeometry(2, 2), this.add);
    this.scene.add(this.quad);
    this.resetHistory();
  }
  resetHistory() {
    this.samples = 0;
    this.previewReady = false;
  }
  present(texture, weight, edgeAA = false) {
    const r = this.renderer;
    if (this.sparkle > 0) {
      const w = Math.max(1, Math.round(this.size.x / 3)),
        h = Math.max(1, Math.round(this.size.y / 3));
      if (w !== this.peaks.width || h !== this.peaks.height) {
        this.peaks.setSize(w, h);
        this.rays.setSize(w, h);
      }
      const u = this.extract.uniforms;
      u.frame.value = texture;
      u.weight.value = weight;
      u.threshold.value =
        (this.float ? 2.25 : 0.78) / Math.max(0.3, r.toneMappingExposure);
      this.quad.material = this.extract;
      r.setRenderTarget(this.peaks);
      r.render(this.scene, this.ortho);
      this.diffraction.uniforms.stepUV.value.set(
        3 / r.domElement.width,
        3 / r.domElement.height,
      );
      this.quad.material = this.diffraction;
      r.setRenderTarget(this.rays);
      r.render(this.scene, this.ortho);
    }
    this.quad.material = this.resolve;
    this.resolve.uniforms.edgeAA.value = edgeAA;
    this.resolve.uniforms.frame.value = texture;
    this.resolve.uniforms.weight.value = weight;
    this.resolve.uniforms.sparkle.value = this.sparkle;
    r.setRenderTarget(null);
    r.render(this.scene, this.ortho);
  }
  drawPreview(scene, focus, aperture) {
    const r = this.renderer,
      c = this.camera;
    this.size.multiplyScalar(0.85).floor();
    this.size.set(Math.max(1, this.size.x), Math.max(1, this.size.y));
    this.previewView.setSize(this.size.x, this.size.y);
    this.preview.setSize(this.size.x, this.size.y);
    const scale =
      aperture * 0.72 * c.projectionMatrix.elements[5] * this.size.y * 0.5;
    this.bokeh.uniforms.coc.value.set(
      scale * (1 / c.far - 1 / c.near),
      scale * (1 / c.near - 1 / Math.max(c.near, focus)),
    );
    r.setRenderTarget(this.previewView);
    r.render(scene, c);
    this.quad.material = this.bokeh;
    r.setRenderTarget(this.preview);
    r.render(this.scene, this.ortho);
    this.present(this.preview.texture, 1, true);
  }
  draw(scene, focus, aperture, interactive) {
    const r = this.renderer,
      c = this.camera;
    const smoothFacets = !interactive && this.float;
    if (interactive) this.resetHistory();
    r.getDrawingBufferSize(this.size);
    const mobileMotion = interactive && this.compactGPU;
    if (mobileMotion) {
      const scale = Math.min(
        1,
        1.65 / r.getPixelRatio(),
        Math.sqrt(1000000 / (this.size.x * this.size.y)),
      );
      this.size.multiplyScalar(scale).floor().max(this.minimumSize);
    }
    if (aperture && (interactive || !this.float || !this.previewReady)) {
      this.drawPreview(scene, focus, aperture);
      this.previewReady = !interactive;
      return !interactive && this.float;
    }
    if (!aperture && !smoothFacets) {
      // Keep the full-size idle target allocated between gestures.
      const target = mobileMotion ? this.previewView : this.view;
      target.setSize(this.size.x, this.size.y);
      r.setRenderTarget(target);
      r.render(scene, c);
      this.present(target.texture, 1, true);
      return false;
    }
    if (
      this.sum.width !== this.size.x ||
      this.sum.height !== this.size.y ||
      this.view.width !== this.size.x ||
      this.view.height !== this.size.y
    ) {
      this.view.setSize(this.size.x, this.size.y);
      this.sum.setSize(this.size.x, this.size.y);
      this.samples = 0;
    }
    const samplesPerBatch = aperture ? 2 : 1;
    const limit = aperture ? 24 : 8;
    const autoClear = r.autoClear;
    if (!this.samples) {
      r.setRenderTarget(this.sum);
      r.setClearColor(0, 0);
      r.clear(true, false, false);
      if (aperture) {
        this.quad.material = this.add;
        this.add.uniforms.frame.value = this.preview.texture;
        this.add.uniforms.weight.value = 2;
        r.render(this.scene, this.ortho);
        this.add.uniforms.frame.value = this.view.texture;
      }
    }
    this.eye.copy(c, false);
    this.axisX.setFromMatrixColumn(c.matrixWorld, 0);
    this.axisY.setFromMatrixColumn(c.matrixWorld, 1);
    this.quad.material = this.add;
    this.add.uniforms.weight.value = 1;
    const apRadius = aperture * 0.72;
    for (
      let k = 0;
      k < samplesPerBatch && this.samples < limit;
      k++, this.samples++
    ) {
      // Stratify radii in a permuted order, so even early batches span the pupil.
      const radius =
        apRadius * Math.sqrt((((this.samples * 7) % limit) + 0.5) / limit);
      const angle = this.samples * 2.399963229728653;
      const x = radius * Math.cos(angle),
        y = radius * Math.sin(angle);
      this.eye.position
        .copy(c.position)
        .addScaledVector(this.axisX, x)
        .addScaledVector(this.axisY, y);
      this.eye.projectionMatrix.copy(c.projectionMatrix);
      const m = this.eye.projectionMatrix.elements;
      m[8] -= (x * m[0]) / Math.max(c.near, focus);
      m[9] -= (y * m[5]) / Math.max(c.near, focus);
      // A rotated eight-point subpixel grid resolves internal facet boundaries;
      // conventional MSAA covers only the outer triangles.
      const i = this.samples % 8;
      m[8] += (((i + 0.5) / 8 - 0.5) * 2) / this.size.x;
      m[9] += (((((i * 3) % 8) + 0.5) / 8 - 0.5) * 2) / this.size.y;
      this.eye.projectionMatrixInverse.copy(this.eye.projectionMatrix).invert();
      r.autoClear = true;
      r.setRenderTarget(this.view);
      r.render(scene, this.eye);
      r.autoClear = false;
      r.setRenderTarget(this.sum);
      r.render(this.scene, this.ortho);
    }
    r.autoClear = autoClear;
    this.present(this.sum.texture, 1 / (this.samples + (aperture ? 2 : 0)));
    return this.samples < limit;
  }
}
