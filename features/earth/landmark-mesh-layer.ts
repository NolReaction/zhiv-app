import type { CustomLayerInterface, CustomRenderMethodInput, Map as LibreMap } from "maplibre-gl";
import { EARTH_LANDMARKS } from "./landmark-catalog";
import { earthLandmarkView, EARTH_LANDMARK_HEIGHT } from "./landmark-layout";
import { createEarthLandmarkMesh } from "./landmark-mesh";

export const EARTH_LANDMARK_MESH_LAYER = "earth-landmark-models";
const EARTH_CIRCUMFERENCE = 40_030_228.884;
type Program = { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> };
const uniformNames = ["u_projection_matrix", "u_projection_fallback_matrix", "u_projection_tile_mercator_coords",
  "u_projection_clipping_plane", "u_projection_transition", "u_anchor", "u_scale", "u_meters", "u_opacity"] as const;

/** One shared VAO/buffer, fixed detail ranges, at most two projection programs. */
export function createEarthLandmarkMeshLayer(map: LibreMap) {
  const ranges = EARTH_LANDMARKS.map(landmark => ({ landmark, start: 0, count: 0, overviewCount: 0,
    anchor: [(landmark.location[0] + 180) / 360,
      (1 - Math.log(Math.tan(Math.PI / 4 + landmark.location[1] * Math.PI / 360)) / Math.PI) / 2] as const,
    meters: EARTH_CIRCUMFERENCE * Math.cos(landmark.location[1] * Math.PI / 180) }));
  const programs = new Map<string, Program>();
  let buffer: WebGLBuffer | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let shown = new Set<string>();
  let visible = false;
  let failed = false;
  let context: WebGL2RenderingContext | null = null;
  let disposed = false;

  function release(gl: WebGL2RenderingContext) {
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
uniform float u_meters;
out vec3 v_color;
void main() {
  vec2 position = u_anchor + vec2(a_position.x, -a_position.y) * u_scale;
  float altitude = a_position.z * u_scale;
  #ifdef GLOBE
    altitude *= u_meters;
  #endif
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
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
  }
  const layer: CustomLayerInterface = {
    id: EARTH_LANDMARK_MESH_LAYER, type: "custom", renderingMode: "3d",
    onAdd(_map, gl) {
      context = gl; failed = false;
      try { initialize(gl); } catch { release(gl); failed = true; }
    },
    render(gl, input) {
      const view = earthLandmarkView(map.getZoom());
      if (disposed || failed || !visible || !shown.size || view.opacity <= 0 || !buffer || !vao) return;
      let compiled = programs.get(input.shaderData.variantName);
      if (!compiled) {
        try {
          compiled = createProgram(gl, input);
          // SDK names may evolve after setProjection. Never accumulate programs.
          if (programs.size >= 2) { for (const { program } of programs.values()) gl.deleteProgram(program); programs.clear(); }
          programs.set(input.shaderData.variantName, compiled);
        } catch { failed = true; return; }
      }
      const { uniforms } = compiled;
      const data = input.defaultProjectionData;
      gl.useProgram(compiled.program); gl.bindVertexArray(vao);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniformMatrix4fv(uniforms.u_projection_matrix, false, new Float32Array(data.mainMatrix));
      gl.uniform4fv(uniforms.u_projection_tile_mercator_coords, data.tileMercatorCoords);
      gl.uniform4fv(uniforms.u_projection_clipping_plane, data.clippingPlane);
      gl.uniform1f(uniforms.u_projection_transition, data.projectionTransition);
      gl.uniform1f(uniforms.u_opacity, view.opacity);
      // Geographic positions remain fixed. Only the atlas miniature's scale is
      // exaggerated; it fades away before real street/building detail appears.
      const scale = EARTH_LANDMARK_HEIGHT * view.scale / (512 * 2 ** map.getZoom());
      gl.uniform1f(uniforms.u_scale, scale);
      const globe = input.shaderData.define.includes("GLOBE");
      for (const range of ranges) {
        if (!shown.has(range.landmark.id)) continue;
        gl.uniform2fv(uniforms.u_anchor, range.anchor);
        gl.uniform1f(uniforms.u_meters, range.meters);
        // The public custom-layer fallback expects conformal mercator z; the
        // globe prelude expects meters. Convert that matrix column per anchor
        // so a globe/mercator projection transition cannot stretch the model.
        const fallback = new Float32Array(data.fallbackMatrix);
        if (globe) for (let index = 8; index < 12; index++) fallback[index] /= range.meters;
        gl.uniformMatrix4fv(uniforms.u_projection_fallback_matrix, false, fallback);
        // Below this size fine lattice aliases. Both levels are already in the
        // same immutable buffer: camera changes select a range, never upload.
        const overview = map.getZoom() < 1.5;
        gl.drawArrays(gl.TRIANGLES, range.start, overview ? range.overviewCount : range.count);
      }
      gl.bindVertexArray(null);
    },
    onRemove(_map, gl) { release(gl); context = null; },
  };
  return {
    layer,
    setVisible(value: boolean, ids: ReadonlySet<string>) {
      if (disposed) return;
      const changed = visible !== value || ids.size !== shown.size || [...ids].some(id => !shown.has(id));
      visible = value; shown = new Set(ids);
      if (changed) map.triggerRepaint();
    },
    dispose() {
      if (disposed) return;
      disposed = true; shown.clear();
      if (context) release(context);
      context = null;
    },
  };
}
