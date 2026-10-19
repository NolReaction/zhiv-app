import type { CustomLayerInterface, CustomRenderMethodInput, Map as LibreMap } from "maplibre-gl";
import { EARTH_LANDMARKS } from "./landmark-catalog";
import { earthLandmarkView, EARTH_LANDMARK_HEIGHT } from "./landmark-layout";
import { createEarthLandmarkMesh } from "./landmark-mesh";
import { browserEarthModelEnvironment, createEarthModelLoader, type EarthModelAssets, type EarthModelEnvironment, type EarthModelLod, type EarthIndexedModel } from "./landmark-model";
import { earthEiffelStreetOpacity, isEarthEiffelStreetZoom } from "./landmark-model-view";
import { EARTH_MODEL_REGISTRY } from "./landmark-model-registry";
import { getEarthModelPlacements, subscribeEarthModelPlacements } from "./model-placement";

export const EARTH_LANDMARK_MESH_LAYER = "earth-landmark-models";
const EARTH_CIRCUMFERENCE = 40_030_228.884;
type Program = { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> };
type ImportedGpuModel = { vertex: WebGLBuffer; index: WebGLBuffer; vao: WebGLVertexArrayObject; count: number; textures: WebGLTexture[] };
type Definition = { id: string; assets: EarthModelAssets; heightMeters: number };
const LODS: readonly EarthModelLod[] = ["overview", "detail"];
const CPU_CACHE_BYTES = 16 * 1024 * 1024;
const keyOf = (id: string, lod: EarthModelLod) => `${id}:${lod}`;
const uniformNames = ["u_projection_matrix", "u_projection_fallback_matrix", "u_projection_tile_mercator_coords",
  "u_projection_clipping_plane", "u_projection_transition", "u_anchor", "u_scale", "u_height", "u_heading", "u_elevation", "u_opacity",
  "u_textured", "u_base_color", "u_normal", "u_metallic_roughness", "u_metallic", "u_roughness", "u_normal_scale"] as const;

/** A permit covers the complete body, digest and image decode, not just HTTP headers. */
function requestPermits(limit = 2) {
  let active = 0;
  const queued: (() => void)[] = [];
  return (signal: AbortSignal) => new Promise<() => void>((resolve, reject) => {
    let started = false;
    const abort = () => {
      if (started) return;
      const index = queued.indexOf(start);
      if (index >= 0) queued.splice(index, 1);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Model request cancelled", "AbortError"));
    };
    const start = () => {
      if (signal.aborted) { abort(); return; }
      if (active >= limit) { queued.push(start); return; }
      started = true; active++; signal.removeEventListener("abort", abort);
      let released = false;
      resolve(() => { if (released) return; released = true; active--; queued.shift()?.(); });
    };
    signal.addEventListener("abort", abort, { once: true }); start();
  });
}

/** Lazy local model assets, a bounded CPU cache and GPU resources only for visible LODs. */
export function createEarthLandmarkMeshLayer(map: LibreMap, options: {
  onModelChange?: () => void; assets?: EarthModelAssets; environment?: EarthModelEnvironment | null; definitions?: readonly Definition[];
} = {}) {
  const ranges = EARTH_LANDMARKS.map(landmark => ({ landmark, start: 0, count: 0, overviewCount: 0,
    anchor: [(landmark.location[0] + 180) / 360,
      (1 - Math.log(Math.tan(Math.PI / 4 + landmark.location[1] * Math.PI / 360)) / Math.PI) / 2] as const,
    meters: EARTH_CIRCUMFERENCE * Math.cos(landmark.location[1] * Math.PI / 180) }));
  const programs = new Map<string, Program>();
  const importedGpu = new Map<string, ImportedGpuModel>();
  const gpuFailures = new Set<string>();
  const lastUsed = new Map<string, number>();
  const draws = new Map<string, string>();
  let clock = 0, reconciling = false;
  let desired = new Map<string, EarthModelLod>();
  let buffer: WebGLBuffer | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let shown = new Set<string>();
  let visible = false;
  let failed = false;
  let context: WebGL2RenderingContext | null = null;
  let disposed = false;
  let lastDraw = "none";
  let activeStreetModels = new Set<string>();
  const baseEnvironment = options.environment === undefined
    ? browserEarthModelEnvironment(typeof map.getContainer === "function" ? map.getContainer().ownerDocument?.defaultView ?? null : null)
    : options.environment;
  const modelEnvironment = baseEnvironment ? { ...baseEnvironment,
    acquire: options.assets ? baseEnvironment.acquire : requestPermits() } : null;
  // The single-asset override is deliberately Eiffel-only for existing embed/test consumers.
  const definitions = options.definitions ?? (options.assets
    ? [{ id: "eiffel-tower", assets: options.assets, heightMeters: 330 }] : EARTH_MODEL_REGISTRY);
  const definitionById = new Map(definitions.map(definition => [definition.id, definition]));
  const imported = new Map(definitions.map(definition => [definition.id, createEarthModelLoader(definition.assets, () => {
    if (disposed) return;
    if (!reconciling) trimCache();
    updateDiagnostics(); options.onModelChange?.();
    if (visible) map.triggerRepaint();
  }, modelEnvironment)]));

  function publishStreetModels(ids: ReadonlySet<string>) {
    if (ids.size === activeStreetModels.size && [...ids].every(id => activeStreetModels.has(id))) return false;
    activeStreetModels = new Set(ids);
    return true;
  }
  const unsubscribePlacements = subscribeEarthModelPlacements(() => {
    if (disposed) return;
    // Valid transform edits keep the successfully drawn GPU model resident.
    // Reconciliation removes culled/hidden IDs; retaining the rest avoids
    // restoring and rebuilding native building filters on every slider input.
    options.onModelChange?.();
    if (visible) map.triggerRepaint();
  });

  function requestedLod(id: string): EarthModelLod | null {
    if (disposed || failed || !context || !visible || !shown.has(id) || !definitionById.has(id)) return null;
    const zoom = map.getZoom();
    if (isEarthEiffelStreetZoom(zoom)) return earthEiffelStreetOpacity(zoom) > 0 ? "detail" : null;
    if (earthLandmarkView(zoom).opacity <= 0) return null;
    return id === "eiffel-tower" && zoom >= 1.5 ? "detail" : "overview";
  }
  function requestedModels() {
    const requests = new Map<string, EarthModelLod>();
    const candidates = [...shown].filter(id => requestedLod(id) !== null);
    if (isEarthEiffelStreetZoom(map.getZoom())) {
      // A pitched camera may cross the horizon, making geographic roof padding
      // unbounded. Local distance and the nearest two slots keep world-wide
      // candidates from loading every detail mesh at that camera angle.
      const center = typeof map.getCenter === "function" ? map.getCenter() : null;
      const placements = new Map(getEarthModelPlacements().map(placement => [placement.id, placement]));
      const distance = (id: string) => {
        if (!center) return 0;
        const placement = placements.get(id), landmark = EARTH_LANDMARKS.find(item => item.id === id);
        const longitude = placement?.longitude ?? landmark?.location[0] ?? 0;
        const latitude = placement?.latitude ?? landmark?.location[1] ?? 0;
        const delta = ((longitude - center.lng + 540) % 360) - 180;
        return Math.hypot(delta * Math.cos(center.lat * Math.PI / 180), latitude - center.lat) * EARTH_CIRCUMFERENCE / 360;
      };
      candidates.sort((a, b) => distance(a) - distance(b));
      for (const id of candidates.filter(id => distance(id) < 50_000).slice(0, 2)) requests.set(id, "detail");
    } else for (const id of candidates) requests.set(id, requestedLod(id)!);
    // Reserve decoded bitmap memory before starting simultaneous detail loads.
    // This is an upper bound, so no active pair can exceed the CPU cache budget.
    let reserved = 0;
    for (const [id, lod] of requests) {
      const asset = definitionById.get(id)!.assets[lod];
      const cost = asset.bytes + (asset.textures?.reduce((sum, texture) => sum + texture.width * texture.height * 4, 0) ?? 0);
      if (reserved + cost > CPU_CACHE_BYTES) requests.delete(id);
      else reserved += cost;
    }
    return requests;
  }
  function updateDiagnostics() {
    if (typeof map.getContainer !== "function") return;
    const dataset = map.getContainer().dataset;
    if (!dataset) return;
    const snapshot = imported.get("eiffel-tower")?.getSnapshot();
    const lod = desired.get("eiffel-tower") ?? null;
    dataset.earthEiffelModelStatus = failed && visible ? "error" : lod ? gpuFailures.has(keyOf("eiffel-tower", lod)) ? "error" : snapshot?.[lod] ?? "idle" : "hidden";
    dataset.earthEiffelModelLod = lod ?? "none";
    dataset.earthEiffelModelBytes = String(snapshot?.bytes ?? 0);
    dataset.earthEiffelModelFetchCount = String(snapshot?.fetchCount ?? 0);
    dataset.earthEiffelModelDraw = lastDraw;
    const statuses = Object.fromEntries([...imported].map(([id, loader]) => {
      const snapshot = loader.getSnapshot(), lod = desired.get(id) ?? null;
      return [id, { ...snapshot, lod, draw: draws.get(id) ?? "none", status: failed && visible ? "error"
        : lod ? gpuFailures.has(keyOf(id, lod)) ? "error" : snapshot[lod] : "hidden" }];
    }));
    dataset.earthModelStatuses = JSON.stringify(statuses);
    dataset.earthModelBytes = String([...imported.values()].reduce((sum, loader) => sum + loader.getSnapshot().bytes, 0));
    dataset.earthModelFetchCount = String([...imported.values()].reduce((sum, loader) => sum + loader.getSnapshot().fetchCount, 0));
    dataset.earthModelDrawCount = String([...draws.values()].filter(draw => draw === "uploaded").length);
  }
  function deleteGpu(gl: WebGL2RenderingContext, key: string) {
    const model = importedGpu.get(key);
    if (!model) return;
    gl.deleteBuffer(model.vertex); gl.deleteBuffer(model.index); gl.deleteVertexArray(model.vao);
    for (const texture of model.textures) gl.deleteTexture(texture);
    importedGpu.delete(key);
  }
  function trimCache() {
    if (reconciling) return;
    reconciling = true;
    try {
      let bytes = [...imported.values()].reduce((sum, loader) => sum + loader.getSnapshot().bytes, 0);
      const pendingBytes = [...desired].reduce((sum, [id, lod]) => {
        if (imported.get(id)?.get(lod)) return sum;
        const asset = definitionById.get(id)!.assets[lod];
        return sum + asset.bytes + (asset.textures?.reduce((total, texture) => total + texture.width * texture.height * 4, 0) ?? 0);
      }, 0);
      const candidates = [...imported].flatMap(([id, loader]) => LODS.filter(lod => loader.get(lod) && desired.get(id) !== lod)
        .map(lod => ({ id, loader, lod, key: keyOf(id, lod) }))).sort((a, b) => (lastUsed.get(a.key) ?? 0) - (lastUsed.get(b.key) ?? 0));
      for (const candidate of candidates) {
        if (bytes + pendingBytes <= CPU_CACHE_BYTES) break;
        const previous = candidate.loader.getSnapshot().bytes;
        candidate.loader.release(candidate.lod);
        if (context) deleteGpu(context, candidate.key);
        bytes -= previous - candidate.loader.getSnapshot().bytes;
      }
    } finally { reconciling = false; }
  }
  function synchronizeImport() {
    const previous = desired;
    desired = requestedModels();
    // Evict inactive bitmaps before allocating another body or decoding images.
    trimCache(); reconciling = true;
    try {
      for (const [id, loader] of imported) {
        if (!options.assets && previous.has(id) && previous.get(id) !== desired.get(id)) loader.request(null);
        loader.request(desired.get(id) ?? null);
      }
      if (context) for (const key of importedGpu.keys()) {
        const [id, lod] = key.split(":");
        if (desired.get(id) !== lod) deleteGpu(context, key);
      }
    } finally { reconciling = false; }
    trimCache(); updateDiagnostics();
  }
  function releaseImported(gl: WebGL2RenderingContext) {
    for (const key of importedGpu.keys()) deleteGpu(gl, key);
    gpuFailures.clear();
  }

  function release(gl: WebGL2RenderingContext) {
    releaseImported(gl);
    for (const { program } of programs.values()) gl.deleteProgram(program);
    programs.clear();
    if (buffer) gl.deleteBuffer(buffer);
    if (vao) gl.deleteVertexArray(vao);
    buffer = null; vao = null;
  }
  function createProgram(gl: WebGL2RenderingContext, input: CustomRenderMethodInput): Program {
    const shaders: WebGLShader[] = [];
    const program = gl.createProgram();
    if (!program) throw new Error("Earth landmark GPU program unavailable");
    try {
      const vertex = `#version 300 es
precision highp float;
${input.shaderData.define}
${input.shaderData.vertexShaderPrelude}
layout(location=0) in vec3 a_position;
layout(location=1) in vec3 a_color;
layout(location=2) in vec3 a_normal;
layout(location=3) in vec2 a_uv;
uniform vec2 u_anchor;
uniform float u_scale;
uniform float u_height;
uniform vec2 u_heading;
uniform float u_elevation;
out vec3 v_color;
out vec3 v_normal;
out vec3 v_position;
out vec2 v_uv;
void main() {
  // Local geometry is east,north,up. Positive heading turns clockwise around
  // up: a north-facing point turns east at +90 degrees.
  vec2 rotated = vec2(a_position.x * u_heading.x + a_position.y * u_heading.y,
    -a_position.x * u_heading.y + a_position.y * u_heading.x);
  vec2 position = u_anchor + vec2(rotated.x, -rotated.y) * u_scale;
  float altitude = a_position.z * u_height + u_elevation;
  gl_Position = projectTileFor3D(position, altitude);
  v_color = a_color;
  v_position = vec3(rotated, a_position.z);
  v_normal = vec3(a_normal.x * u_heading.x + a_normal.y * u_heading.y,
    -a_normal.x * u_heading.y + a_normal.y * u_heading.x, a_normal.z);
  v_uv = a_uv;
}`;
      const fragment = `#version 300 es
precision highp float;
in vec3 v_color;
in vec3 v_normal;
in vec3 v_position;
in vec2 v_uv;
uniform float u_opacity;
uniform float u_textured;
uniform sampler2D u_base_color;
uniform sampler2D u_normal;
uniform sampler2D u_metallic_roughness;
uniform float u_metallic;
uniform float u_roughness;
uniform float u_normal_scale;
out vec4 fragColor;
vec3 linearToSrgb(vec3 value) {
  value = max(value, vec3(0.0));
  return mix(value * 12.92, 1.055 * pow(value, vec3(1.0 / 2.4)) - .055, step(vec3(.0031308), value));
}
void main() {
  // ELM1 and the procedural atlas retain their authored vertex colours exactly.
  if (u_textured < .5) { fragColor = vec4(v_color * u_opacity, u_opacity); return; }
  // SRGB8_ALPHA8 decodes base colour before interpolation and mip filtering.
  vec3 base = texture(u_base_color, v_uv).rgb * v_color;
  vec3 normal = normalize(v_normal);
  if (!gl_FrontFacing) normal = -normal;
  vec3 dp1 = dFdx(v_position), dp2 = dFdy(v_position);
  vec2 duv1 = dFdx(v_uv), duv2 = dFdy(v_uv);
  vec3 dp2perp = cross(dp2, normal), dp1perp = cross(normal, dp1);
  vec3 tangent = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 bitangent = dp2perp * duv1.y + dp1perp * duv2.y;
  float frameLength = max(dot(tangent, tangent), dot(bitangent, bitangent));
  if (frameLength > 1e-12) {
    vec3 detail = texture(u_normal, v_uv).xyz * 2.0 - 1.0;
    detail.xy *= u_normal_scale;
    float scale = inversesqrt(frameLength);
    normal = normalize(mat3(tangent * scale, bitangent * scale, normal) * normalize(detail));
  }
  // Normal and metallic/roughness textures are linear data, unlike base colour.
  vec3 material = texture(u_metallic_roughness, v_uv).rgb;
  float roughness = clamp(material.g * u_roughness, .08, 1.0);
  float metallic = clamp(material.b * u_metallic, 0.0, 1.0);
  vec3 light = normalize(vec3(-.35, -.45, .82));
  vec3 halfLight = normalize(light + normalize(vec3(.25, -.55, .85)));
  float diffuse = max(dot(normal, light), 0.0);
  float gloss = pow(max(dot(normal, halfLight), 0.0), mix(96.0, 4.0, roughness));
  vec3 reflectance = mix(vec3(.04), base, metallic);
  vec3 lit = base * (.48 + .52 * diffuse) * (1.0 - metallic * .45)
    + reflectance * gloss * (1.0 - roughness * .65) * .7;
  fragColor = vec4(linearToSrgb(lit) * u_opacity, u_opacity);
}`;
      for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error("Earth landmark GPU shader unavailable");
        shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "Earth landmark shader failed");
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "Earth landmark program failed");
      return { program, uniforms: Object.fromEntries(uniformNames.map(name => [name, gl.getUniformLocation(program, name)])) };
    } catch (error) {
      gl.deleteProgram(program);
      throw error;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }
  function initialize(gl: WebGL2RenderingContext) {
    const geometry: number[] = [];
    for (const range of ranges) {
      const mesh = createEarthLandmarkMesh(range.landmark.kind);
      range.start = geometry.length / 6; range.count = mesh.length / 6;
      for (const value of mesh) geometry.push(value);
      range.overviewCount = range.landmark.kind === "eiffel-tower"
        ? createEarthLandmarkMesh(range.landmark.kind, "overview").length / 6 : range.count;
    }
    buffer = gl.createBuffer(); vao = gl.createVertexArray();
    if (!buffer || !vao) throw new Error("Earth landmark GPU buffer unavailable");
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geometry), gl.STATIC_DRAW);
    if (gl.getBufferParameter(gl.ARRAY_BUFFER, gl.BUFFER_SIZE) !== geometry.length * 4) throw new Error("Earth landmark GPU upload failed");
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
  }
  function textureState(gl: WebGL2RenderingContext) {
    const active = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
    const bindings = [0, 1, 2].map(unit => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      return gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    });
    const pixelStore = [gl.UNPACK_FLIP_Y_WEBGL, gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
      gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.UNPACK_ALIGNMENT].map(name => [name, gl.getParameter(name)] as const);
    return () => {
      for (const [index, binding] of bindings.entries()) { gl.activeTexture(gl.TEXTURE0 + index); gl.bindTexture(gl.TEXTURE_2D, binding); }
      for (const [name, value] of pixelStore) gl.pixelStorei(name, value);
      gl.activeTexture(active);
    };
  }
  function uploadImported(gl: WebGL2RenderingContext, key: string, model: EarthIndexedModel): ImportedGpuModel | null {
    const existing = importedGpu.get(key);
    if (existing) return existing;
    if (gpuFailures.has(key)) return null;
    let vertex: WebGLBuffer | null = null, index: WebGLBuffer | null = null, modelVao: WebGLVertexArrayObject | null = null;
    const textures: WebGLTexture[] = [];
    let restoreTextures: (() => void) | null = null;
    try {
      vertex = gl.createBuffer(); index = gl.createBuffer(); modelVao = gl.createVertexArray();
      if (!vertex || !index || !modelVao) throw new Error("Earth imported model buffer unavailable");
      gl.bindVertexArray(modelVao); gl.bindBuffer(gl.ARRAY_BUFFER, vertex); gl.bufferData(gl.ARRAY_BUFFER, model.vertices, gl.STATIC_DRAW);
      // WebGL reports allocation failure through state, usually without throwing.
      // Do not expose a street target until both buffers actually exist on GPU.
      if (gl.getBufferParameter(gl.ARRAY_BUFFER, gl.BUFFER_SIZE) !== model.vertices.byteLength) throw new Error("Earth imported model vertex upload failed");
      const stride = (model.vertexStride ?? 6) * 4;
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
      if (model.textureMaterial) {
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 24);
        gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 36);
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, model.indices, gl.STATIC_DRAW);
      if (gl.getBufferParameter(gl.ELEMENT_ARRAY_BUFFER, gl.BUFFER_SIZE) !== model.indices.byteLength) throw new Error("Earth imported model index upload failed");
      if (model.textureMaterial) {
        restoreTextures = textureState(gl);
        // ImageBitmaps already contain glTF's top-first rows. In particular,
        // UNPACK_FLIP_Y_WEBGL does not affect ImageBitmap uploads.
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        for (const [unit, kind] of (["baseColor", "normal", "metallicRoughness"] as const).entries()) {
          const slot = model.textureMaterial.textures.find(texture => texture.kind === kind);
          const texture = gl.createTexture();
          if (!texture) throw new Error("Earth model texture unavailable");
          textures.push(texture);
          if (slot && (slot.image.width !== slot.width || slot.image.height !== slot.height)) throw new Error("Earth model texture dimensions changed");
          gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture);
          const internalFormat = kind === "baseColor" ? gl.SRGB8_ALPHA8 : gl.RGBA8;
          if (slot) gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, gl.RGBA, gl.UNSIGNED_BYTE, slot.image);
          else gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
            new Uint8Array(kind === "normal" ? [128, 128, 255, 255] : [255, 255, 255, 255]));
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, slot?.wrapS ?? gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, slot?.wrapT ?? gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.generateMipmap(gl.TEXTURE_2D);
          if (gl.getError() !== gl.NO_ERROR) throw new Error("Earth model texture upload failed");
        }
      }
      const result = { vertex, index, vao: modelVao, count: model.indices.length, textures }; importedGpu.set(key, result);
      return result;
    } catch {
      if (vertex) gl.deleteBuffer(vertex); if (index) gl.deleteBuffer(index); if (modelVao) gl.deleteVertexArray(modelVao);
      for (const texture of textures) gl.deleteTexture(texture);
      gpuFailures.add(key); return null;
    } finally { restoreTextures?.(); }
  }
  const layer: CustomLayerInterface = {
    id: EARTH_LANDMARK_MESH_LAYER, type: "custom", renderingMode: "3d",
    onAdd(_map, gl) {
      if (disposed) return;
      context = gl; failed = false;
      try { initialize(gl); } catch { release(gl); failed = true; }
      synchronizeImport();
    },
    render(gl, input) {
      synchronizeImport();
      const zoom = map.getZoom(), view = earthLandmarkView(zoom), street = isEarthEiffelStreetZoom(zoom);
      const opacity = street ? earthEiffelStreetOpacity(zoom) : view.opacity;
      lastDraw = "none";
      draws.clear();
      if (disposed || failed || !visible || !shown.size || opacity <= 0 || !buffer || !vao) {
        const changed = publishStreetModels(new Set());
        updateDiagnostics();
        if (changed) options.onModelChange?.();
        return;
      }
      let compiled = programs.get(input.shaderData.variantName);
      if (!compiled) {
        try {
          compiled = createProgram(gl, input);
          // SDK names may evolve after setProjection. Never accumulate programs.
          if (programs.size >= 2) { for (const { program } of programs.values()) gl.deleteProgram(program); programs.clear(); }
          programs.set(input.shaderData.variantName, compiled);
        } catch { failed = true; publishStreetModels(new Set()); synchronizeImport(); options.onModelChange?.(); return; }
      }
      const { uniforms } = compiled;
      gl.useProgram(compiled.program); gl.bindVertexArray(vao);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(uniforms.u_opacity, opacity);
      const globe = input.shaderData.define.includes("GLOBE");
      let modelChanged = false;
      const streetModels = new Set<string>();
      const placements = new Map(getEarthModelPlacements().map(placement => [placement.id, placement]));
      for (const range of ranges) {
        const eiffel = range.landmark.id === "eiffel-tower";
        if (!shown.has(range.landmark.id) || street && !desired.has(range.landmark.id)) continue;
        const lod = desired.get(range.landmark.id);
        const key = lod ? keyOf(range.landmark.id, lod) : null;
        const model = lod ? imported.get(range.landmark.id)?.get(lod) : null;
        const previouslyUploaded = key ? importedGpu.has(key) : false, previouslyFailed = key ? gpuFailures.has(key) : false;
        const gpu = model && key ? uploadImported(gl, key, model) : null;
        if (model && key) {
          lastUsed.set(key, ++clock);
          if (previouslyUploaded !== importedGpu.has(key) || previouslyFailed !== gpuFailures.has(key)) modelChanged = true;
        }
        // A failed/pending street import leaves the existing OSM view intact.
        if (street && !gpu) continue;
        let data = input.defaultProjectionData;
        let scale = EARTH_LANDMARK_HEIGHT * view.scale / (512 * 2 ** zoom);
        let height = scale * (globe ? range.meters : 1);
        let anchor: readonly [number, number] = range.anchor;
        let meters = range.meters;
        const placement = placements.get(range.landmark.id);
        if (placement) {
          anchor = [(placement.longitude + 180) / 360,
            (1 - Math.log(Math.tan(Math.PI / 4 + placement.latitude * Math.PI / 360)) / Math.PI) / 2];
          meters = EARTH_CIRCUMFERENCE * Math.cos(placement.latitude * Math.PI / 180);
          height = scale * (globe ? meters : 1);
        }
        const heading = (placement?.headingDegrees ?? 0) * Math.PI / 180;
        gl.uniform2fv(uniforms.u_heading, [Math.cos(heading), Math.sin(heading)]);
        let elevation = 0;
        if (street) {
          // Native tile-local coordinates avoid float32 world-position jitter
          // at street zoom. Both tile projection paths accept heights in metres.
          const z = 14, tiles = 2 ** z, extent = 8192;
          const x = Math.floor(anchor[0] * tiles), y = Math.floor(anchor[1] * tiles);
          // +180° lies on the next world boundary. Keep canonical tile IDs
          // inside [0, 2^z), retaining the world copy separately for Mercator.
          const canonicalX = ((x % tiles) + tiles) % tiles, wrap = Math.floor(x / tiles);
          data = input.getProjectionData({ tileID: { canonical: { z, x: canonicalX, y }, wrap }, applyGlobeMatrix: true });
          anchor = [(anchor[0] * tiles - x) * extent, (anchor[1] * tiles - y) * extent];
          height = placement?.heightMeters ?? definitionById.get(range.landmark.id)?.heightMeters ?? 330;
          scale = height / meters * tiles * extent;
          elevation = placement?.elevationMeters ?? 0;
        }
        gl.uniformMatrix4fv(uniforms.u_projection_matrix, false, new Float32Array(data.mainMatrix));
        gl.uniform4fv(uniforms.u_projection_tile_mercator_coords, data.tileMercatorCoords);
        gl.uniform4fv(uniforms.u_projection_clipping_plane, data.clippingPlane);
        gl.uniform1f(uniforms.u_projection_transition, data.projectionTransition);
        gl.uniform2fv(uniforms.u_anchor, anchor); gl.uniform1f(uniforms.u_scale, scale); gl.uniform1f(uniforms.u_height, height);
        gl.uniform1f(uniforms.u_elevation, elevation);
        // The public custom-layer fallback expects conformal mercator z; the
        // globe prelude expects meters. Convert that matrix column per anchor
        // so a globe/mercator projection transition cannot stretch the model.
        const fallback = new Float32Array(data.fallbackMatrix);
        if (globe && !street) for (let index = 8; index < 12; index++) fallback[index] /= meters;
        gl.uniformMatrix4fv(uniforms.u_projection_fallback_matrix, false, fallback);
        // Prepared LODs reuse their indexed buffers. Until they arrive, the
        // procedural atlas uses its two fixed ranges without duplicate draws.
        if (gpu) {
          gl.bindVertexArray(gpu.vao);
          let restoreTextures: (() => void) | null = null;
          try {
            const material = model?.textureMaterial;
            gl.uniform1f(uniforms.u_textured, material ? 1 : 0);
            if (material) {
              restoreTextures = textureState(gl);
              for (const [unit, texture] of gpu.textures.entries()) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture); }
              gl.uniform1i(uniforms.u_base_color, 0); gl.uniform1i(uniforms.u_normal, 1); gl.uniform1i(uniforms.u_metallic_roughness, 2);
              gl.uniform1f(uniforms.u_metallic, material.metallicFactor); gl.uniform1f(uniforms.u_roughness, material.roughnessFactor);
              gl.uniform1f(uniforms.u_normal_scale, material.normalScale);
            }
            gl.drawElements(gl.TRIANGLES, gpu.count, gl.UNSIGNED_INT, 0);
            if (material && gl.getError() !== gl.NO_ERROR) throw new Error("Earth model draw failed");
            draws.set(range.landmark.id, "uploaded");
            if (eiffel) lastDraw = "uploaded";
            if (street) streetModels.add(range.landmark.id);
          } catch {
            // An unsuccessful draw must leave the native map available.
            if (key) { gpuFailures.add(key); deleteGpu(gl, key); }
            modelChanged = true;
          } finally { restoreTextures?.(); }
        }
        else {
          gl.uniform1f(uniforms.u_textured, 0); gl.bindVertexArray(vao);
          gl.drawArrays(gl.TRIANGLES, range.start, zoom < 1.5 ? range.overviewCount : range.count);
          draws.set(range.landmark.id, "procedural"); if (eiffel) lastDraw = "procedural";
        }
      }
      gl.bindVertexArray(null);
      if (publishStreetModels(streetModels)) modelChanged = true;
      updateDiagnostics();
      // Notify after the indexed draw, never from an asynchronous fetch callback
      // or halfway through setting WebGL state. This also hides failed targets.
      if (modelChanged) options.onModelChange?.();
    },
    onRemove(_map, gl) {
      release(gl); context = null; desired.clear(); for (const loader of imported.values()) loader.request(null); lastDraw = "none"; draws.clear();
      const changed = publishStreetModels(new Set());
      updateDiagnostics();
      if (changed) options.onModelChange?.();
    },
  };
  return {
    layer,
    setVisible(value: boolean, ids: ReadonlySet<string>) {
      if (disposed) return;
      const changed = visible !== value || ids.size !== shown.size || [...ids].some(id => !shown.has(id));
      visible = value; shown = new Set(ids);
      const active = visible && isEarthEiffelStreetZoom(map.getZoom()) && earthEiffelStreetOpacity(map.getZoom()) > 0
        ? new Set([...activeStreetModels].filter(id => shown.has(id))) : new Set<string>();
      publishStreetModels(active);
      if (!visible) { lastDraw = "none"; draws.clear(); }
      synchronizeImport();
      publishStreetModels(new Set([...activeStreetModels].filter(id => {
        const lod = desired.get(id);
        return !!lod && importedGpu.has(keyOf(id, lod));
      })));
      if (changed) map.triggerRepaint();
    },
    isImportedEiffelReady(lod: EarthModelLod = "detail") { return !disposed && !failed && !!context && importedGpu.has(keyOf("eiffel-tower", lod)); },
    isImportedModelReady(id: string, lod: EarthModelLod = "detail") {
      return !disposed && !failed && !!context && importedGpu.has(keyOf(id, lod));
    },
    getActiveStreetModelIds(): ReadonlySet<string> { return activeStreetModels; },
    getModelSnapshot() {
      const models = Object.fromEntries([...imported].map(([id, loader]) => [id, loader.getSnapshot()]));
      return { ...models["eiffel-tower"], models,
        bytes: Object.values(models).reduce((sum, model) => sum + model.bytes, 0),
        fetchCount: Object.values(models).reduce((sum, model) => sum + model.fetchCount, 0) };
    },
    dispose() {
      if (disposed) return;
      disposed = true; shown.clear();
      unsubscribePlacements();
      activeStreetModels.clear();
      for (const loader of imported.values()) loader.dispose(); lastDraw = "none"; draws.clear(); desired.clear();
      if (context) release(context);
      context = null;
      updateDiagnostics();
    },
  };
}
