/** Worker-copy MVT 2.1 transformation. OpenFreeMap groups unrelated buildings
 * with identical properties into MultiPolygon features. Separate their exterior
 * rings before style filters run so a local model mask cannot hide a whole tile.
 * Provider/cache bytes and every non-building layer stay byte-for-byte intact.
 * https://github.com/mapbox/vector-tile-spec/tree/master/2.1 */
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_FIELDS = 250_000;
const MAX_POINTS = 200_000;
const MAX_FEATURES = 50_000;
const MAX_RINGS = 50_000;
const MIN_INT32 = -2_147_483_648;
const MAX_INT32 = 2_147_483_647;
type Field = { tag: number; wire: number; start: number; end: number; valueStart: number; valueEnd: number };
type Point = readonly [number, number];
type Ring = Point[];
type Budget = { fields: number; points: number; features: number; rings: number; outputBytes: number };
const invalid = () => new Error("Invalid or oversized Earth building vector geometry");

function uint32(bytes: Uint8Array, cursor: { at: number }, end: number): number {
  let value = 0;
  for (let index = 0; index < 5; index++) {
    if (cursor.at >= end) throw invalid();
    const byte = bytes[cursor.at++];
    if (index === 4 && byte > 15) throw invalid();
    value += (byte & 127) * 2 ** (index * 7);
    if (byte < 128) return value;
  }
  throw invalid();
}

function skipVarint(bytes: Uint8Array, cursor: { at: number }, end: number) {
  for (let index = 0; index < 10; index++) {
    if (cursor.at >= end) throw invalid();
    const byte = bytes[cursor.at++];
    if (index === 9 && byte > 1) throw invalid();
    if (byte < 128) return;
  }
  throw invalid();
}

function fields(bytes: Uint8Array, start: number, end: number, budget: Budget): Field[] {
  const result: Field[] = [];
  const cursor = { at: start };
  while (cursor.at < end) {
    if (++budget.fields > MAX_FIELDS) throw invalid();
    const start = cursor.at;
    const key = uint32(bytes, cursor, end);
    const tag = Math.floor(key / 8), wire = key & 7;
    if (!tag) throw invalid();
    let valueStart = cursor.at;
    if (wire === 0) skipVarint(bytes, cursor, end);
    else if (wire === 1) cursor.at += 8;
    else if (wire === 5) cursor.at += 4;
    else if (wire === 2) {
      const length = uint32(bytes, cursor, end);
      valueStart = cursor.at;
      cursor.at += length;
    } else throw invalid();
    if (cursor.at > end) throw invalid();
    result.push({ tag, wire, start, end: cursor.at, valueStart, valueEnd: cursor.at });
  }
  return result;
}

function varint(value: number, target: number[]) {
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    target.push(byte + (value ? 128 : 0));
  } while (value);
}

function packedField(tag: number, payload: Uint8Array): Uint8Array {
  const header: number[] = [];
  varint(tag * 8 + 2, header);
  varint(payload.byteLength, header);
  const result = new Uint8Array(header.length + payload.byteLength);
  result.set(header); result.set(payload, header.length);
  return result;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let length = 0;
  for (const part of parts) {
    length += part.byteLength;
    if (length > MAX_OUTPUT_BYTES) throw invalid();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

function scalar(bytes: Uint8Array, field: Field) {
  if (field.wire !== 0) throw invalid();
  const cursor = { at: field.valueStart };
  const value = uint32(bytes, cursor, field.valueEnd);
  if (cursor.at !== field.valueEnd) throw invalid();
  return value;
}

function geometryPolygons(bytes: Uint8Array, geometry: readonly Field[], budget: Budget): Ring[][] {
  const values: number[] = [];
  for (const field of geometry) {
    if (field.wire !== 2 && field.wire !== 0) throw invalid();
    const cursor = { at: field.valueStart };
    while (cursor.at < field.valueEnd) {
      values.push(uint32(bytes, cursor, field.valueEnd));
      if (values.length > MAX_POINTS * 3 + MAX_RINGS * 2) throw invalid();
    }
  }
  const polygons: Ring[][] = [];
  let x = 0, y = 0, index = 0;
  let ring: Ring | null = null;
  while (index < values.length) {
    const command = values[index++], operation = command & 7, count = Math.floor(command / 8);
    if (!count) throw invalid();
    if (operation === 1 || operation === 2) {
      if (operation === 1 ? count !== 1 || ring !== null : ring === null) throw invalid();
      if (count > Math.floor((values.length - index) / 2) || budget.points + count > MAX_POINTS) throw invalid();
      if (operation === 1) ring = [];
      for (let point = 0; point < count; point++) {
        const dx = values[index++], dy = values[index++];
        x += dx % 2 ? -(dx + 1) / 2 : dx / 2;
        y += dy % 2 ? -(dy + 1) / 2 : dy / 2;
        if (x < MIN_INT32 || x > MAX_INT32 || y < MIN_INT32 || y > MAX_INT32) throw invalid();
        ring!.push([x, y]);
      }
      budget.points += count;
    } else if (operation === 7) {
      if (count !== 1 || !ring || ring.length < 3 || ++budget.rings > MAX_RINGS) throw invalid();
      let area = 0;
      for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
        const term = (ring[previous][0] - ring[current][0]) * (ring[previous][1] + ring[current][1]);
        if (!Number.isSafeInteger(term) || !Number.isSafeInteger(area + term)) throw invalid();
        area += term;
      }
      if (!area) throw invalid();
      if (area > 0) polygons.push([ring]);
      else {
        if (!polygons.length) throw invalid();
        polygons[polygons.length - 1].push(ring);
      }
      // ClosePath closes the ring but leaves the delta cursor at its last point.
      ring = null;
    } else throw invalid();
  }
  if (ring || !polygons.length) throw invalid();
  return polygons;
}

function encodePolygon(rings: readonly Ring[]): Uint8Array {
  const result: number[] = [];
  let x = 0, y = 0;
  const point = ([nextX, nextY]: Point) => {
    const dx = nextX - x, dy = nextY - y;
    if (dx < MIN_INT32 || dx > MAX_INT32 || dy < MIN_INT32 || dy > MAX_INT32) throw invalid();
    varint(dx < 0 ? -dx * 2 - 1 : dx * 2, result);
    varint(dy < 0 ? -dy * 2 - 1 : dy * 2, result);
    x = nextX; y = nextY;
  };
  for (const ring of rings) {
    result.push(9); point(ring[0]);
    varint((ring.length - 1) * 8 + 2, result);
    for (let index = 1; index < ring.length; index++) point(ring[index]);
    result.push(15);
  }
  return new Uint8Array(result);
}

function splitFeature(bytes: Uint8Array, feature: Field, budget: Budget): Uint8Array[] | null {
  const contents = fields(bytes, feature.valueStart, feature.valueEnd, budget);
  const types = contents.filter(field => field.tag === 3);
  if (!types.length || scalar(bytes, types[types.length - 1]) !== 3) return null;
  const geometry = contents.filter(field => field.tag === 4);
  if (!geometry.length) throw invalid();
  const polygons = geometryPolygons(bytes, geometry, budget);
  if (polygons.length === 1) return null;
  if (budget.features + polygons.length > MAX_FEATURES) throw invalid();
  budget.features += polygons.length;
  const remaining = contents.filter(field => field.tag !== 4);
  const metadata = remaining.map(field => bytes.subarray(field.start, field.end));
  const metadataBytes = metadata.reduce((size, part) => size + part.byteLength, 0);
  if (metadataBytes * polygons.length > MAX_OUTPUT_BYTES) throw invalid();
  budget.outputBytes -= feature.end - feature.start;
  return polygons.map(polygon => {
    const result = packedField(2, concatenate([...metadata, packedField(4, encodePolygon(polygon))]));
    budget.outputBytes += result.byteLength;
    if (budget.outputBytes > MAX_OUTPUT_BYTES) throw invalid();
    return result;
  });
}

function buildingLayer(bytes: Uint8Array, layer: Field, budget: Budget): Uint8Array | null {
  const contents = fields(bytes, layer.valueStart, layer.valueEnd, budget);
  const names = contents.filter(field => field.tag === 1);
  const name = names[names.length - 1];
  if (!name || name.wire !== 2) return null;
  const expected = "building";
  if (name.valueEnd - name.valueStart !== expected.length
    || ![...expected].every((letter, index) => bytes[name.valueStart + index] === letter.charCodeAt(0))) return null;
  let changed = false;
  const parts: Uint8Array[] = [];
  for (const field of contents) {
    if (field.tag === 2) {
      if (field.wire !== 2 || ++budget.features > MAX_FEATURES) throw invalid();
      const split = splitFeature(bytes, field, budget);
      if (split) { parts.push(...split); changed = true; continue; }
    }
    parts.push(bytes.subarray(field.start, field.end));
  }
  return changed ? packedField(3, concatenate(parts)) : null;
}

/** Reject malformed/oversized input before producing any partially rewritten
 * tile. An unchanged single-polygon tile returns its original ArrayBuffer. */
export function splitEarthBuildingTileGeometry(data: ArrayBuffer): ArrayBuffer {
  if (data.byteLength > MAX_INPUT_BYTES) throw invalid();
  const bytes = new Uint8Array(data);
  const budget: Budget = { fields: 0, points: 0, features: 0, rings: 0, outputBytes: data.byteLength };
  const tile = fields(bytes, 0, bytes.byteLength, budget);
  let changed = false;
  const parts = tile.map(field => {
    if (field.tag === 3) {
      if (field.wire !== 2) throw invalid();
      const layer = buildingLayer(bytes, field, budget);
      if (layer) { changed = true; return layer; }
    }
    return bytes.subarray(field.start, field.end);
  });
  return changed ? concatenate(parts).buffer : data;
}
