import assert from "node:assert/strict";

/** Records actual affine transforms without depending on the DOM or raster reads. */
export function recordingShipCanvas(failOn) {
  let state = { transform: [1, 0, 0, 1, 11, 13], globalAlpha: .37, filter: "blur(2px)",
    fillStyle: "original", strokeStyle: "original", lineWidth: 7, lineCap: "square", lineJoin: "bevel",
    globalCompositeOperation: "xor", imageSmoothingEnabled: false, imageSmoothingQuality: "low" };
  const snapshot = () => ({ ...state, transform: [...state.transform] });
  const original = snapshot(), stack = [], calls = [];
  let gradientId = 0;
  const finite = value => { if (typeof value === "number") assert.ok(Number.isFinite(value), `nonfinite ${value}`); };
  const ctx = new Proxy({}, {
    get(_, key) {
      if (key in state) return state[key];
      if (["canvas", "getImageData", "createPattern"].includes(key)) throw new Error(`Unexpected raster/DOM dependency: ${key}`);
      return (...args) => {
        args.flat(Infinity).forEach(finite);
        calls.push({ key, args, state: snapshot() });
        if (key === failOn) throw new Error("canvas failure");
        if (key === "save") stack.push(snapshot());
        else if (key === "restore") { assert.ok(stack.length); state = stack.pop(); }
        else if (key === "createLinearGradient" || key === "createRadialGradient") return {
          gradient: ++gradientId, addColorStop(offset, color) { finite(offset); assert.ok(!/NaN|Infinity/.test(color)); calls.push({ key: "colorStop", args: [offset, color] }); },
        };
        else if (["translate", "scale", "rotate"].includes(key)) {
          const [a,b,c,d,e,f] = state.transform;
          const [p,q,r,s,x,y] = key === "translate" ? [1,0,0,1,...args] : key === "scale" ? [args[0],0,0,args[1],0,0]
            : [Math.cos(args[0]),Math.sin(args[0]),-Math.sin(args[0]),Math.cos(args[0]),0,0];
          state.transform = [a*p+c*q,b*p+d*q,a*r+c*s,b*r+d*s,a*x+c*y+e,b*x+d*y+f];
        }
      };
    },
    set(_, key, value) { finite(value); state[key] = value; return true; },
  });
  return { ctx, calls, snapshot, original, depth: () => stack.length };
}
