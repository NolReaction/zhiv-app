import type { CustomLayerInterface, CustomRenderMethodInput, Map as LibreMap } from "maplibre-gl";

export const EARTH_NIGHT_SHADE_LAYER = "earth-evening-shade";
export const EARTH_NIGHT_MAX_ALPHA = 0.36;
const COLUMNS = 128;
const ROWS = 64;
const MAX_LATITUDE = 85.0511287798066;
type Vector = readonly [number, number, number];
type Program = { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> };
const uniformNames = ["u_projection_matrix", "u_projection_fallback_matrix", "u_projection_tile_mercator_coords",
  "u_projection_clipping_plane", "u_projection_transition", "u_sun", "u_center_x"] as const;

/** A single surface, rather than overlapping polygons in an overzoomed GeoJSON tile. */
export function createEarthNightMesh(): Float32Array {
  const values: number[] = [];
  function vertex(x: number, latitude: number, center: number, pole = 0) {
    const longitude = (x * 360 - 180) * Math.PI / 180;
    const angle = latitude * Math.PI / 180;
    const y = pole ? pole < 0 ? 0 : 1 : (1 - Math.log(Math.tan(Math.PI / 4 + angle / 2)) / Math.PI) / 2;
    values.push(x, y, pole, Math.cos(angle) * Math.cos(longitude), Math.cos(angle) * Math.sin(longitude), Math.sin(angle), center);
  }
  for (let column = 0; column < COLUMNS; column++) {
    const left = column / COLUMNS, right = (column + 1) / COLUMNS, center = (left + right) / 2;
    for (let row = 0; row < ROWS; row++) {
      const north = MAX_LATITUDE * (1 - row * 2 / ROWS), south = MAX_LATITUDE * (1 - (row + 1) * 2 / ROWS);
      vertex(left, north, center); vertex(left, south, center); vertex(right, north, center);
      vertex(right, north, center); vertex(left, south, center); vertex(right, south, center);
    }
    vertex(left, MAX_LATITUDE, center); vertex(right, MAX_LATITUDE, center); vertex(center, 90, center, -32768);
    vertex(right, -MAX_LATITUDE, center); vertex(left, -MAX_LATITUDE, center); vertex(center, -90, center, 32767);
  }
  return new Float32Array(values);
}

/** Same analytic transfer used by the fragment shader; independent of camera zoom. */
export function earthNightAlpha(facing: number): number {
  const value = Math.max(0, Math.min(1, (facing + 0.34) / 0.39));
  return EARTH_NIGHT_MAX_ALPHA * (1 - value * value * (3 - 2 * value));
}

/** Public SDK projection prelude handles globe clipping, poles and the Mercator transition. */
export function createEarthNightShadeLayer(map: Pick<LibreMap, "getCenter" | "triggerRepaint">) {
  const programs = new Map<string, Program>();
  let buffer: WebGLBuffer | null = null, vao: WebGLVertexArrayObject | null = null;
  let context: WebGL2RenderingContext | null = null;
  let vertexCount = 0, enabled = false, visible = true, failed = false, disposed = false;
  let sun: Vector = [1, 0, 0];
  function release(gl: WebGL2RenderingContext) {
    for (const { program } of programs.values()) gl.deleteProgram(program);
    programs.clear();
    if (buffer) gl.deleteBuffer(buffer);
    if (vao) gl.deleteVertexArray(vao);
    buffer = null; vao = null;
  }
  function compile(gl: WebGL2RenderingContext, input: CustomRenderMethodInput): Program {
    const shaders: WebGLShader[] = [], program = gl.createProgram();
    if (!program) throw new Error("Earth night program unavailable");
    const vertex = `#version 300 es
precision highp float;
${input.shaderData.define}
${input.shaderData.vertexShaderPrelude}
layout(location=0) in vec3 a_position;
layout(location=1) in vec3 a_normal;
layout(location=2) in float a_center;
uniform float u_center_x;
out vec3 v_normal;
void main() {
  // Every triangle uses one longitude wrap. The discontinuity stays on the
  // opposite hemisphere, never through a visible date-line neighbourhood.
  vec2 position = a_position.xy + vec2(floor(u_center_x - a_center + 0.5), 0.0);
  gl_Position = projectTile(position, vec2(0.0, a_position.z));
  v_normal = a_normal;
}`;
    const fragment = `#version 300 es
precision highp float;
in vec3 v_normal;
uniform vec3 u_sun;
out vec4 fragColor;
void main() {
  float facing = dot(normalize(v_normal), u_sun);
  float darkness = 1.0 - smoothstep(-0.34, 0.05, facing);
  float alpha = ${EARTH_NIGHT_MAX_ALPHA.toFixed(2)} * darkness;
  vec3 color = mix(vec3(0.81, 0.61, 0.43), vec3(0.12, 0.22, 0.29), smoothstep(0.2, 0.85, darkness));
  fragColor = vec4(color * alpha, alpha);
}`;
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error("Earth night shader unavailable");
        shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("Earth night shader failed");
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Earth night link failed");
      return { program, uniforms: Object.fromEntries(uniformNames.map(name => [name, gl.getUniformLocation(program, name)])) };
    } catch (error) { gl.deleteProgram(program); throw error; }
    finally { for (const shader of shaders) gl.deleteShader(shader); }
  }
  const layer: CustomLayerInterface = {
    id: EARTH_NIGHT_SHADE_LAYER, type: "custom", renderingMode: "2d",
    onAdd(_map, gl) {
      context = gl; failed = false;
      try {
        const mesh = createEarthNightMesh(); vertexCount = mesh.length / 7;
        buffer = gl.createBuffer(); vao = gl.createVertexArray();
        if (!buffer || !vao) throw new Error("Earth night buffer unavailable");
        gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);
        for (const [index, size, offset] of [[0, 3, 0], [1, 3, 12], [2, 1, 24]]) {
          gl.enableVertexAttribArray(index); gl.vertexAttribPointer(index, size, gl.FLOAT, false, 28, offset);
        }
        gl.bindVertexArray(null);
      } catch { release(gl); failed = true; }
    },
    render(gl, input) {
      if (disposed || failed || !enabled || !visible || !buffer || !vao) return;
      let compiled = programs.get(input.shaderData.variantName);
      if (!compiled) {
        try {
          compiled = compile(gl, input);
          if (programs.size >= 2) { for (const { program } of programs.values()) gl.deleteProgram(program); programs.clear(); }
          programs.set(input.shaderData.variantName, compiled);
        } catch { failed = true; return; }
      }
      const data = input.defaultProjectionData, uniforms = compiled.uniforms;
      gl.useProgram(compiled.program); gl.bindVertexArray(vao);
      // SDK projectTile clips the far hemisphere in homogeneous Z. No shared
      // depth writes: the tint also covers 3D roofs while labels stay above it.
      gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniformMatrix4fv(uniforms.u_projection_matrix, false, new Float32Array(data.mainMatrix));
      gl.uniformMatrix4fv(uniforms.u_projection_fallback_matrix, false, new Float32Array(data.fallbackMatrix));
      gl.uniform4fv(uniforms.u_projection_tile_mercator_coords, data.tileMercatorCoords);
      gl.uniform4fv(uniforms.u_projection_clipping_plane, data.clippingPlane);
      gl.uniform1f(uniforms.u_projection_transition, data.projectionTransition);
      gl.uniform3fv(uniforms.u_sun, sun);
      gl.uniform1f(uniforms.u_center_x, (map.getCenter().lng + 180) / 360);
      gl.drawArrays(gl.TRIANGLES, 0, vertexCount); gl.bindVertexArray(null);
    },
    onRemove(_map, gl) { release(gl); context = null; },
  };
  return {
    layer,
    setLighting(next: Vector | null) {
      if (disposed) return;
      const changed = enabled !== (next !== null) || !!next && next.some((value, index) => value !== sun[index]);
      enabled = next !== null; if (next) sun = [...next];
      if (changed && visible) map.triggerRepaint();
    },
    setVisible(next: boolean) { if (!disposed && visible !== next) { visible = next; map.triggerRepaint(); } },
    dispose() { if (disposed) return; disposed = true; if (context) release(context); context = null; },
  };
}
