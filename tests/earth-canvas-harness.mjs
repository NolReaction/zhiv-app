/** Small deterministic Canvas2D stand-in: records drawing, real ImageData storage. */
export function earthTestCanvasContext() {
  const calls = [];
  const context = { calls, imageData: null,
    createImageData(width, height) { const value = { width, height, data: new Uint8ClampedArray(width * height * 4) }; calls.push(["createImageData", width, height]); return value; },
    putImageData(value, x, y) { context.imageData = value; calls.push(["putImageData", value.width, value.height, x, y]); },
    createLinearGradient(...values) { calls.push(["createLinearGradient", ...values]); return { addColorStop(...stop) { calls.push(["addColorStop", ...stop]); } }; },
  };
  for (const method of ["setTransform", "clearRect", "save", "restore", "beginPath", "moveTo", "lineTo", "closePath", "clip", "translate", "transform", "drawImage", "fillRect", "arc", "fill", "stroke"])
    context[method] = (...values) => calls.push([method, ...values]);
  return context;
}
