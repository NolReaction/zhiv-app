import type { CustomLayerInterface, CustomRenderMethodInput, Map as LibreMap } from "maplibre-gl";
import { EARTH_LANDMARKS } from "./landmark-catalog";
import { earthLandmarkView, EARTH_LANDMARK_HEIGHT } from "./landmark-layout";
import { createEarthLandmarkMesh } from "./landmark-mesh";
import modelAssets from "./data/eiffel-model.json";
import { browserEarthModelEnvironment, createEarthModelLoader, type EarthModelAssets, type EarthModelEnvironment, type EarthModelLod, type EarthIndexedModel } from "./landmark-model";
import { EARTH_EIFFEL_HEIGHT_METERS, earthEiffelStreetOpacity, isEarthEiffelStreetZoom } from "./landmark-model-view";
import { getEarthModelPlacements, subscribeEarthModelPlacements } from "./model-placement";

export const EARTH_LANDMARK_MESH_LAYER = "earth-landmark-models";
const EARTH_CIRCUMFERENCE = 40_030_228.884;
type Program = { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> };
type ImportedGpuModel = { vertex: WebGLBuffer; index: WebGLBuffer; vao: WebGLVertexArrayObject; count: number };
const uniformNames = ["u_projection_matrix", "u_projection_fallback_matrix", "u_projection_tile_mercator_coords",
  "u_projection_clipping_plane", "u_projection_transition", "u_anchor", "u_scale", "u_height", "u_heading", "u_elevation", "u_opacity"] as const;

/** One procedural atlas plus two bounded imported Eiffel LODs; at most two projection programs. */
export function createEarthLandmarkMeshLayer(map: LibreMap, options: {
  onModelChange?: () => void; assets?: EarthModelAssets; environment?: EarthModelEnvironment | null;
} = {}) {
  const ranges = EARTH_LANDMARKS.map(landmark => ({ landmark, start: 0, count: 0, overviewCount: 0,
    anchor: [(landmark.location[0] + 180) / 360,
      (1 - Math.log(Math.tan(Math.PI / 4 + landmark.location[1] * Math.PI / 360)) / Math.PI) / 2] as const,
    meters: EARTH_CIRCUMFERENCE * Math.cos(landmark.location[1] * Math.PI / 180) }));
  const programs = new Map<string, Program>();
  const importedGpu = new Map<EarthModelLod, ImportedGpuModel>();
  const gpuFailures = new Set<EarthModelLod>();
  let buffer: WebGLBuffer | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let shown = new Set<string>();
  let visible = false;
  let failed = false;
  let context: WebGL2RenderingContext | null = null;
  let disposed = false;
  let lastDraw = "none";
  let activeStreetModels = new Set<string>();
  const modelEnvironment = options.environment === undefined
    ? browserEarthModelEnvironment(typeof map.getContainer === "function" ? map.getContainer().ownerDocument?.defaultView ?? null : null)
    : options.environment;
  const imported = createEarthModelLoader(options.assets ?? modelAssets, () => {
    if (disposed) return;
    updateDiagnostics();
    options.onModelChange?.();
    if (visible) map.triggerRepaint();
  }, modelEnvironment);

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

  function desiredLod(): EarthModelLod | null {
    if (disposed || failed || !context || !visible || !shown.has("eiffel-tower")) return null;
    const zoom = map.getZoom();
    if (isEarthEiffelStreetZoom(zoom)) return "detail";
    if (earthLandmarkView(zoom).opacity <= 0) return null;
    return zoom < 1.5 ? "overview" : "detail";
  }
  function updateDiagnostics() {
    if (typeof map.getContainer !== "function") return;
    const dataset = map.getContainer().dataset;
    if (!dataset) return;
    const snapshot = imported.getSnapshot(), lod = desiredLod();
    dataset.earthEiffelModelStatus = failed && visible ? "error" : lod ? gpuFailures.has(lod) ? "error" : snapshot[lod] : "hidden";
    dataset.earthEiffelModelLod = lod ?? "none";
    dataset.earthEiffelModelBytes = String(snapshot.bytes);
    dataset.earthEiffelModelFetchCount = String(snapshot.fetchCount);
    dataset.earthEiffelModelDraw = lastDraw;
  }
  function synchronizeImport() { imported.request(desiredLod()); updateDiagnostics(); }
  function releaseImported(gl: WebGL2RenderingContext) {
    for (const model of importedGpu.values()) { gl.deleteBuffer(model.vertex); gl.deleteBuffer(model.index); gl.deleteVertexArray(model.vao); }
    importedGpu.clear(); gpuFailures.clear();
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
uniform vec2 u_anchor;
uniform float u_scale;
uniform float u_height;
uniform vec2 u_heading;
uniform float u_elevation;
out vec3 v_color;
void main() {
  // Local geometry is east,north,up. Positive heading turns clockwise around
  // up: a north-facing point turns east at +90 degrees.
  vec2 rotated = vec2(a_position.x * u_heading.x + a_position.y * u_heading.y,
    -a_position.x * u_heading.y + a_position.y * u_heading.x);
  vec2 position = u_anchor + vec2(rotated.x, -rotated.y) * u_scale;
  float altitude = a_position.z * u_height + u_elevation;
  gl_Position = projectTileFor3D(position, altitude);
  v_color = a_color;
}`;
      const fragment = `#version 300 es
precision highp float;
in vec3 v_color;
uniform float u_opacity;
out vec4 fragColor;
void main() { fragColor = vec4(v_color * u_opacity, u_opacity); }`;
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
  function uploadImported(gl: WebGL2RenderingContext, lod: EarthModelLod, model: EarthIndexedModel): ImportedGpuModel | null {
    const existing = importedGpu.get(lod);
    if (existing) return existing;
    if (gpuFailures.has(lod)) return null;
    let vertex: WebGLBuffer | null = null, index: WebGLBuffer | null = null, modelVao: WebGLVertexArrayObject | null = null;
    try {
      vertex = gl.createBuffer(); index = gl.createBuffer(); modelVao = gl.createVertexArray();
      if (!vertex || !index || !modelVao) throw new Error("Earth imported model buffer unavailable");
      gl.bindVertexArray(modelVao); gl.bindBuffer(gl.ARRAY_BUFFER, vertex); gl.bufferData(gl.ARRAY_BUFFER, model.vertices, gl.STATIC_DRAW);
      // WebGL reports allocation failure through state, usually without throwing.
      // Do not expose a street target until both buffers actually exist on GPU.
      if (gl.getBufferParameter(gl.ARRAY_BUFFER, gl.BUFFER_SIZE) !== model.vertices.byteLength) throw new Error("Earth imported model vertex upload failed");
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, model.indices, gl.STATIC_DRAW);
      if (gl.getBufferParameter(gl.ELEMENT_ARRAY_BUFFER, gl.BUFFER_SIZE) !== model.indices.byteLength) throw new Error("Earth imported model index upload failed");
      const result = { vertex, index, vao: modelVao, count: model.indices.length }; importedGpu.set(lod, result);
      return result;
    } catch {
      if (vertex) gl.deleteBuffer(vertex); if (index) gl.deleteBuffer(index); if (modelVao) gl.deleteVertexArray(modelVao);
      gpuFailures.add(lod); return null;
    }
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
      const zoom = map.getZoom(), view = earthLandmarkView(zoom), street = isEarthEiffelStreetZoom(zoom);
      const opacity = street ? earthEiffelStreetOpacity(zoom) : view.opacity;
      lastDraw = "none";
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
        if (!shown.has(range.landmark.id) || street && !eiffel) continue;
        const lod: EarthModelLod = street || zoom >= 1.5 ? "detail" : "overview";
        const model = eiffel ? imported.get(lod) : null;
        const previouslyUploaded = importedGpu.has(lod), previouslyFailed = gpuFailures.has(lod);
        const gpu = model ? uploadImported(gl, lod, model) : null;
        if (model && (previouslyUploaded !== importedGpu.has(lod) || previouslyFailed !== gpuFailures.has(lod))) modelChanged = true;
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
          height = placement?.heightMeters ?? EARTH_EIFFEL_HEIGHT_METERS;
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
          try {
            gl.drawElements(gl.TRIANGLES, gpu.count, gl.UNSIGNED_INT, 0);
            lastDraw = "uploaded";
            if (street) streetModels.add(range.landmark.id);
          } catch {
            // An unsuccessful draw must leave the native map available.
            gpuFailures.add(lod);
            gl.deleteBuffer(gpu.vertex); gl.deleteBuffer(gpu.index); gl.deleteVertexArray(gpu.vao);
            importedGpu.delete(lod);
            modelChanged = true;
          }
        }
        else { gl.bindVertexArray(vao); gl.drawArrays(gl.TRIANGLES, range.start, zoom < 1.5 ? range.overviewCount : range.count); if (eiffel) lastDraw = "procedural"; }
      }
      gl.bindVertexArray(null);
      if (publishStreetModels(streetModels)) modelChanged = true;
      updateDiagnostics();
      // Notify after the indexed draw, never from an asynchronous fetch callback
      // or halfway through setting WebGL state. This also hides failed targets.
      if (modelChanged) options.onModelChange?.();
    },
    onRemove(_map, gl) {
      release(gl); context = null; imported.request(null); lastDraw = "none";
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
      if (!visible) lastDraw = "none";
      synchronizeImport();
      if (changed) map.triggerRepaint();
    },
    isImportedEiffelReady(lod: EarthModelLod = "detail") { return !disposed && !failed && !!context && importedGpu.has(lod); },
    isImportedModelReady(id: string, lod: EarthModelLod = "detail") {
      return id === "eiffel-tower" && !disposed && !failed && !!context && importedGpu.has(lod);
    },
    getActiveStreetModelIds(): ReadonlySet<string> { return activeStreetModels; },
    getModelSnapshot: imported.getSnapshot,
    dispose() {
      if (disposed) return;
      disposed = true; shown.clear();
      unsubscribePlacements();
      activeStreetModels.clear();
      imported.dispose(); lastDraw = "none";
      if (context) release(context);
      context = null;
      updateDiagnostics();
    },
  };
}
