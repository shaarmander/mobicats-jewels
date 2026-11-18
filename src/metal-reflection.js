import * as T from "three";

// Keep the sharp reflection in its native cube. Only the broader reflection
// lobes need the filtered atlas and its equally large scratch texture.
export class DesktopMetalReflection {
  constructor(size) {
    this.capture = new T.WebGLCubeRenderTarget(size, {
      format: T.RGBFormat,
      type: T.UnsignedInt101111Type,
      generateMipmaps: true,
      minFilter: T.LinearMipmapLinearFilter,
    });
    this.filterSource = new T.WebGLCubeRenderTarget(512, {
      type: T.HalfFloatType,
      depthBuffer: false,
    });
    this.copyScene = new T.Scene();
    this.copyScene.background = this.capture.texture;
    this.copyCamera = new T.CubeCamera(0.1, 10, this.filterSource);
    this.localCube = { value: null };
    this.ready = { value: false };
    this.size = size;
  }
  apply(material) {
    const reflection = this;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.localMetalCube = reflection.localCube;
      shader.uniforms.localMetalReady = reflection.ready;
      shader.uniforms.localMetalSize = { value: reflection.size };
      // Three r180 normally floors roughness for a 256-pixel PMREM face.
      // Retain its normal-derivative antialiasing for curved metal.
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <lights_physical_fragment>",
          T.ShaderChunk.lights_physical_fragment.replace(
            "max( roughnessFactor, 0.0525 )",
            "max( roughnessFactor, 0.024 )",
          ),
        )
        .replace(
          "#include <envmap_physical_pars_fragment>",
          `uniform samplerCube localMetalCube;
         uniform bool localMetalReady;
         uniform float localMetalSize;\n` +
            T.ShaderChunk.envmap_physical_pars_fragment.replace(
              "vec4 envMapColor = textureCubeUV( envMap, envMapRotation * reflectVec, roughness );",
              `float footprint = max(length(dFdx(reflectVec)), length(dFdy(reflectVec)));
           if (localMetalReady && roughness < 0.12) {
             // Broaden both subpixel reflections and the physical specular lobe.
             float lod = log2(max(1.0, localMetalSize * max(roughness * roughness, footprint)));
             vec3 sharp = textureLod(localMetalCube, reflectVec, lod).rgb;
             if (roughness <= 0.07) return sharp * envMapIntensity;
             vec3 filtered = textureCubeUV(envMap, envMapRotation * reflectVec, roughness).rgb;
             return mix(sharp, filtered, smoothstep(0.07, 0.12, roughness)) * envMapIntensity;
           }
           vec4 envMapColor = textureCubeUV( envMap, envMapRotation * reflectVec, roughness );`,
            ),
        );
    };
    material.customProgramCacheKey = () => "desktop-polished-metal";
  }
  pause() {
    // A texture attached to the framebuffer cannot be sampled during capture.
    this.localCube.value = null;
    this.ready.value = false;
  }
  filter(renderer, generator, target) {
    this.copyCamera.update(renderer, this.copyScene);
    const result = generator.fromCubemap(this.filterSource.texture, target);
    this.localCube.value = this.capture.texture;
    this.ready.value = true;
    return result;
  }
}
