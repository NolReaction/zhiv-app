// Deliberately restricted, offline glTF profile. Unsupported appearance is an
// error instead of silently producing a different-looking browser asset.
const MAX_VERTICES = 1_000_000;
const MAX_INDICES = 3_000_000;
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const fail = message => { throw new Error(`Earth model GLB: ${message}`); };
const finite = values => Array.isArray(values) && values.every(Number.isFinite);

function multiply(a, b) {
  return Array.from({ length: 16 }, (_, i) => {
    const row = i % 4, column = Math.floor(i / 4);
    return a[row] * b[column * 4] + a[row + 4] * b[column * 4 + 1]
      + a[row + 8] * b[column * 4 + 2] + a[row + 12] * b[column * 4 + 3];
  });
}

function transform(node) {
  if (node.matrix) {
    if (!finite(node.matrix) || node.matrix.length !== 16 || node.translation || node.rotation || node.scale)
      fail("invalid node matrix");
    if (node.matrix[3] || node.matrix[7] || node.matrix[11] || node.matrix[15] !== 1) fail("non-affine node matrix");
    return node.matrix;
  }
  const translation = node.translation ?? [0, 0, 0], scale = node.scale ?? [1, 1, 1];
  const rotation = node.rotation ?? [0, 0, 0, 1];
  if (!finite(translation) || translation.length !== 3 || !finite(scale) || scale.length !== 3
    || !finite(rotation) || rotation.length !== 4 || Math.abs(Math.hypot(...rotation) - 1) > 0.0001) fail("invalid node TRS");
  const [x, y, z, w] = rotation, [sx, sy, sz] = scale;
  return [(1 - 2 * y * y - 2 * z * z) * sx, (2 * x * y + 2 * w * z) * sx, (2 * x * z - 2 * w * y) * sx, 0,
    (2 * x * y - 2 * w * z) * sy, (1 - 2 * x * x - 2 * z * z) * sy, (2 * y * z + 2 * w * x) * sy, 0,
    (2 * x * z + 2 * w * y) * sz, (2 * y * z - 2 * w * x) * sz, (1 - 2 * x * x - 2 * y * y) * sz, 0,
    ...translation, 1];
}

function normalMatrix(m) {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const cofactor = [e * i - f * h, f * g - d * i, d * h - e * g,
    c * h - b * i, a * i - c * g, b * g - a * h,
    b * f - c * e, c * d - a * f, a * e - b * d];
  const determinant = a * cofactor[0] + b * cofactor[1] + c * cofactor[2];
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) fail("singular node transform");
  return { matrix: cofactor.map(value => value / determinant), determinant };
}

export function readEarthModelGlb(input) {
  if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)
    || input.byteLength < 28 || input.byteLength > 32 * 1024 * 1024) fail("invalid GLB 2 header/size");
  const bytes = input instanceof ArrayBuffer ? Buffer.from(input) : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.readUInt32LE(0) !== 0x46546c67
    || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) fail("invalid GLB 2 header/size");
  let json, binary;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) fail("truncated chunk header");
    const size = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (size % 4 || end > bytes.length) fail("invalid chunk boundary");
    if (type === 0x4e4f534a && offset === 12) json = JSON.parse(bytes.subarray(offset + 8, end).toString("utf8"));
    else if (type === 0x004e4942 && json && !binary) binary = bytes.subarray(offset + 8, end);
    else fail("unsupported or duplicate chunk");
    offset = end;
  }
  if (!json || !binary || json.asset?.version !== "2.0" || json.buffers?.length !== 1
    || json.buffers[0].uri || !Number.isInteger(json.buffers[0].byteLength)
    || json.buffers[0].byteLength > binary.length || binary.length - json.buffers[0].byteLength > 3) fail("expected one embedded buffer");
  if (json.extensionsUsed?.length || json.extensionsRequired?.length || json.animations?.length
    || json.skins?.length || json.textures?.length || json.images?.length) fail("extensions, animation, skins and textures are unsupported");
  const bufferLength = json.buffers[0].byteLength;

  function accessor(id, types, components) {
    const value = json.accessors?.[id], view = json.bufferViews?.[value?.bufferView];
    if (!value || !view || value.sparse || view.buffer !== 0 || !types.includes(value.type)
      || !components.includes(value.componentType) || !Number.isInteger(value.count) || value.count < 1
      || value.count > (value.type === "SCALAR" ? MAX_INDICES : MAX_VERTICES)
      || value.normalized && (value.componentType === 5126 || value.type === "SCALAR")) fail(`unsupported accessor ${id}`);
    const size = { SCALAR: 1, VEC3: 3, VEC4: 4 }[value.type];
    const componentSize = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 }[value.componentType];
    const stride = view.byteStride ?? size * componentSize, viewOffset = view.byteOffset ?? 0, localOffset = value.byteOffset ?? 0;
    const viewLength = view.byteLength;
    if (![viewOffset, localOffset, stride, viewLength].every(Number.isInteger)
      || viewOffset < 0 || localOffset < 0 || viewLength < 0 || stride < size * componentSize || stride > 252
      || stride % componentSize || (viewOffset + localOffset) % componentSize || viewOffset + viewLength > bufferLength
      || localOffset + (value.count - 1) * stride + size * componentSize > viewLength) fail(`out of range accessor ${id}`);
    const data = new Float64Array(value.count * size);
    for (let index = 0; index < value.count; index++) for (let axis = 0; axis < size; axis++) {
      const offset = viewOffset + localOffset + index * stride + axis * componentSize;
      const raw = value.componentType === 5126 ? binary.readFloatLE(offset) : value.componentType === 5125
        ? binary.readUInt32LE(offset) : value.componentType === 5123 ? binary.readUInt16LE(offset) : binary.readUInt8(offset);
      if (!Number.isFinite(raw)) fail(`nonfinite accessor ${id}`);
      data[index * size + axis] = value.normalized ? raw / (value.componentType === 5121 ? 255 : 65535) : raw;
    }
    return { data, count: value.count, size };
  }

  const positions = [], normals = [], colors = [], indices = [];
  const roots = json.scenes?.[json.scene ?? 0]?.nodes;
  if (!Array.isArray(roots) || !roots.length) fail("missing active scene");
  let instances = 0, degenerateTriangles = 0, sourceIndexCount = 0;
  function visit(id, parent, ancestors) {
    if (!Number.isInteger(id) || !json.nodes?.[id] || ancestors.has(id) || ancestors.size > 64 || ++instances > 1024)
      fail("invalid or cyclic node graph");
    const node = json.nodes[id], world = multiply(parent, transform(node));
    if (node.skin !== undefined || node.weights || node.extensions) fail("unsupported node features");
    if (node.mesh !== undefined) {
      const mesh = json.meshes?.[node.mesh], normal = normalMatrix(world);
      if (!mesh?.primitives?.length) fail("missing mesh primitives");
      for (const primitive of mesh.primitives) {
        if ((primitive.mode ?? 4) !== 4 || primitive.targets || primitive.extensions) fail("only static triangles are supported");
        const sourceCount = json.accessors?.[primitive.attributes?.POSITION]?.count;
        const indexCount = primitive.indices === undefined ? sourceCount : json.accessors?.[primitive.indices]?.count;
        if (!Number.isInteger(sourceCount) || sourceCount < 1 || positions.length / 3 + sourceCount > MAX_VERTICES)
          fail("vertex budget exceeded");
        if (!Number.isInteger(indexCount) || indexCount < 3 || indexCount % 3 || sourceIndexCount + indexCount > MAX_INDICES)
          fail("source triangle budget exceeded");
        // Count work before allocating/accessing it, including discarded
        // degenerate triangles and repeated instances of the same mesh.
        sourceIndexCount += indexCount;
        const source = accessor(primitive.attributes?.POSITION, ["VEC3"], [5126]);
        const sourceNormals = primitive.attributes.NORMAL === undefined ? null : accessor(primitive.attributes.NORMAL, ["VEC3"], [5126]);
        const sourceColors = primitive.attributes.COLOR_0 === undefined ? null : accessor(primitive.attributes.COLOR_0, ["VEC3", "VEC4"], [5121, 5123, 5126]);
        if (sourceNormals && sourceNormals.count !== source.count || sourceColors && sourceColors.count !== source.count)
          fail("attribute count mismatch");
        const material = primitive.material === undefined ? {} : json.materials?.[primitive.material];
        if (!material || material.extensions || material.alphaMode && material.alphaMode !== "OPAQUE"
          || material.pbrMetallicRoughness?.baseColorTexture || material.normalTexture || material.emissiveTexture
          || material.occlusionTexture || material.emissiveFactor?.some(value => value !== 0)
          || material.pbrMetallicRoughness?.metallicRoughnessTexture) fail("unsupported material appearance");
        const color = material.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
        if (!finite(color) || color.length !== 4 || color.some(channel => channel < 0 || channel > 1) || color[3] !== 1)
          fail("only opaque normalized base colors are supported");
        const base = positions.length / 3;
        if (base + source.count > MAX_VERTICES) fail("vertex budget exceeded");
        for (let vertex = 0; vertex < source.count; vertex++) {
          const [x, y, z] = source.data.subarray(vertex * 3, vertex * 3 + 3);
          // Full glTF scene graph first, then +Y-up to east/north/up.
          positions.push(world[0] * x + world[4] * y + world[8] * z + world[12],
            -(world[2] * x + world[6] * y + world[10] * z + world[14]),
            world[1] * x + world[5] * y + world[9] * z + world[13]);
          const n = sourceNormals?.data.subarray(vertex * 3, vertex * 3 + 3) ?? [0, 0, 0], m = normal.matrix;
          normals.push(m[0] * n[0] + m[1] * n[1] + m[2] * n[2],
            -(m[6] * n[0] + m[7] * n[1] + m[8] * n[2]), m[3] * n[0] + m[4] * n[1] + m[5] * n[2]);
          for (let axis = 0; axis < 3; axis++) {
            const channel = sourceColors ? sourceColors.data[vertex * sourceColors.size + axis] : 1;
            if (channel < 0 || channel > 1) fail("vertex color out of range");
            colors.push(color[axis] * channel);
          }
          if (sourceColors?.size === 4 && sourceColors.data[vertex * 4 + 3] !== 1) fail("transparent vertex color");
        }
        const triangles = primitive.indices === undefined ? Array.from({ length: source.count }, (_, index) => index)
          : accessor(primitive.indices, ["SCALAR"], [5121, 5123, 5125]).data;
        if (triangles.length % 3 || indices.length + triangles.length > MAX_INDICES) fail("invalid triangle count/budget");
        for (let offset = 0; offset < triangles.length; offset += 3) {
          const local = Array.from(triangles.subarray?.(offset, offset + 3) ?? triangles.slice(offset, offset + 3));
          if (local.some(index => !Number.isInteger(index) || index < 0 || index >= source.count)) fail("triangle index out of range");
          if (normal.determinant < 0) [local[1], local[2]] = [local[2], local[1]];
          const [a, b, c] = local.map(index => (base + index) * 3);
          const u = [0, 1, 2].map(axis => positions[b + axis] - positions[a + axis]);
          const v = [0, 1, 2].map(axis => positions[c + axis] - positions[a + axis]);
          const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
          if (Math.hypot(...cross) < 1e-12) { degenerateTriangles++; continue; }
          indices.push(...local.map(index => base + index));
          if (!sourceNormals) for (const index of [a, b, c]) for (let axis = 0; axis < 3; axis++) normals[index + axis] += cross[axis];
        }
      }
    }
    const next = new Set(ancestors).add(id);
    for (const child of node.children ?? []) visit(child, world, next);
  }
  for (const root of roots) visit(root, identity(), new Set());
  if (!indices.length || !positions.every(Number.isFinite) || !normals.every(Number.isFinite)) fail("empty or nonfinite geometry");
  // Bounds only consider referenced vertices, never abandoned exporter data.
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  for (const index of indices) for (let axis = 0; axis < 3; axis++) {
    minimum[axis] = Math.min(minimum[axis], positions[index * 3 + axis]);
    maximum[axis] = Math.max(maximum[axis], positions[index * 3 + axis]);
  }
  const height = maximum[2] - minimum[2];
  if (height < 1e-9 || !Number.isFinite(height)) fail("model has no height");
  const origin = [(minimum[0] + maximum[0]) / 2, (minimum[1] + maximum[1]) / 2, minimum[2]];
  // Exporters may keep unused vertices or vertices referenced only by discarded
  // degenerates. They must not affect bounds, locks, or simplifier allocations.
  const referenced = new Uint8Array(positions.length / 3);
  for (const index of indices) referenced[index] = 1;
  const count = referenced.reduce((sum, value) => sum + value, 0), remap = new Uint32Array(referenced.length);
  const compactPositions = new Float32Array(count * 3), compactNormals = new Float32Array(count * 3), compactColors = new Float32Array(count * 3);
  let next = 0;
  for (let vertex = 0; vertex < referenced.length; vertex++) {
    if (!referenced[vertex]) continue;
    remap[vertex] = next;
    const length = Math.hypot(normals[vertex * 3], normals[vertex * 3 + 1], normals[vertex * 3 + 2]);
    for (let axis = 0; axis < 3; axis++) {
      const value = (positions[vertex * 3 + axis] - origin[axis]) / height;
      if (!Number.isFinite(value) || Math.abs(value) > 1.5) fail("model is outside normalized bounds");
      compactPositions[next * 3 + axis] = value;
      compactNormals[next * 3 + axis] = length > 1e-12 ? normals[vertex * 3 + axis] / length : 0;
      compactColors[next * 3 + axis] = colors[vertex * 3 + axis];
    }
    next++;
  }
  return { positions: compactPositions, normals: compactNormals, colors: compactColors,
    indices: new Uint32Array(indices.map(index => remap[index])), sourceHeight: height, origin, degenerateTriangles,
    attribution: json.asset.extras ?? {} };
}
