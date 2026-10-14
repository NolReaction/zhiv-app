/** Retained RGBA8 surfaces are a useful estimate, not a browser/GPU allocation measurement. */
export type CacheMemoryResource = { value: object; pixels: number; kind: "canvas" | "decoded-image" };
export type CacheMemoryGroup = { count: number; pixels: number; bytesEstimate: number };
export type CacheMemoryEstimate = {
  basis: "rgba8-and-retained-byte-buffers";
  actualMemoryMeasured: false;
  canvasCount: number; canvasPixels: number; canvasBytesEstimate: number;
  decodedImageCount: number; decodedImagePixels: number; decodedImageBytesEstimate: number;
  retainedBufferBytes: number; totalBytesEstimate: number;
  groups: Record<string, CacheMemoryGroup>;
};

export function canvasMemoryResources(canvases: Iterable<HTMLCanvasElement | undefined>): CacheMemoryResource[] {
  const result: CacheMemoryResource[] = [];
  for (const canvas of canvases) if (canvas) result.push({ value: canvas, pixels: canvas.width * canvas.height, kind: "canvas" });
  return result;
}

/** A shared identity set prevents a source referenced by several caches being charged twice. */
export function estimateCacheMemory(groups: Readonly<Record<string, Iterable<CacheMemoryResource>>>, retainedBufferBytes = 0,
  seen = new Set<object>()): CacheMemoryEstimate {
  const result: CacheMemoryEstimate = {
    basis: "rgba8-and-retained-byte-buffers", actualMemoryMeasured: false,
    canvasCount: 0, canvasPixels: 0, canvasBytesEstimate: 0,
    decodedImageCount: 0, decodedImagePixels: 0, decodedImageBytesEstimate: 0,
    retainedBufferBytes, totalBytesEstimate: retainedBufferBytes, groups: {},
  };
  for (const [name, resources] of Object.entries(groups)) {
    const group = result.groups[name] = { count: 0, pixels: 0, bytesEstimate: 0 };
    for (const resource of resources) {
      if (seen.has(resource.value)) continue;
      seen.add(resource.value);
      const pixels = Number.isFinite(resource.pixels) ? Math.max(0, resource.pixels) : 0;
      group.count++; group.pixels += pixels; group.bytesEstimate += pixels * 4;
      if (resource.kind === "canvas") { result.canvasCount++; result.canvasPixels += pixels; }
      else { result.decodedImageCount++; result.decodedImagePixels += pixels; }
    }
  }
  result.canvasBytesEstimate = result.canvasPixels * 4;
  result.decodedImageBytesEstimate = result.decodedImagePixels * 4;
  result.totalBytesEstimate += result.canvasBytesEstimate + result.decodedImageBytesEstimate;
  return result;
}

/** Estimates merged here must have been collected with the same identity set. */
export function mergeCacheMemory(...estimates: CacheMemoryEstimate[]): CacheMemoryEstimate {
  const result = estimateCacheMemory({});
  for (const estimate of estimates) {
    result.canvasCount += estimate.canvasCount; result.canvasPixels += estimate.canvasPixels;
    result.canvasBytesEstimate += estimate.canvasBytesEstimate;
    result.decodedImageCount += estimate.decodedImageCount; result.decodedImagePixels += estimate.decodedImagePixels;
    result.decodedImageBytesEstimate += estimate.decodedImageBytesEstimate;
    result.retainedBufferBytes += estimate.retainedBufferBytes; result.totalBytesEstimate += estimate.totalBytesEstimate;
    for (const [name, group] of Object.entries(estimate.groups)) {
      const target = result.groups[name] ??= { count: 0, pixels: 0, bytesEstimate: 0 };
      target.count += group.count; target.pixels += group.pixels; target.bytesEstimate += group.bytesEstimate;
    }
  }
  return result;
}
