import type { AddProtocolAction } from "maplibre-gl";
import { appendEarthTileBase, isEarthTileIndexUrl, isEarthVectorTileUrl, prepareEarthTileIndex } from "./tile-base";

function abortError(): DOMException { return new DOMException("Map request cancelled", "AbortError"); }
export type EarthResourceProtocolOutcome = "completed" | "aborted" | "timeout" | "error";

/** A retained map gets a fresh request generation when it returns to the screen. */
export function createEarthRequestScope(lifetimeSignal: AbortSignal, initiallyVisible = true) {
  let generation = new AbortController();
  let visible = initiallyVisible;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    lifetimeSignal.removeEventListener("abort", dispose);
    generation.abort();
  };
  if (lifetimeSignal.aborted) dispose();
  else {
    lifetimeSignal.addEventListener("abort", dispose, { once: true });
    if (!visible) generation.abort();
    // Covers synchronous cancellation during observer registration.
    if (lifetimeSignal.aborted) dispose();
  }
  return {
    signal: () => generation.signal,
    setVisible(next: boolean) {
      if (disposed || lifetimeSignal.aborted || next === visible) return;
      visible = next;
      if (visible) generation = new AbortController();
      else generation.abort();
    },
    dispose,
  };
}

/**
 * Tile requests belong to both their SDK request and the map that started them.
 * Worker teardown must not leave a cache consumer holding a network queue slot
 * when the SDK does not cancel its custom-protocol controller on map removal.
 * The shared runtime installation deliberately does not use this protocol.
 */
export function createEarthResourceProtocol(readProtocol: AddProtocolAction, mapSignal: AbortSignal | (() => AbortSignal),
  onOutcome?: (outcome: EarthResourceProtocolOutcome) => void): AddProtocolAction {
  // Resource outcomes include cache hits. Diagnostics receive no URL, tile ID,
  // error text or coordinates, and cannot interrupt delivery of a valid tile.
  const report = (outcome: EarthResourceProtocolOutcome) => { try { onOutcome?.(outcome); } catch { /* Optional diagnostics. */ } };
  return async (parameters, requestController) => {
    // Capture this generation once: resuming the map never revives an old request.
    const scopeSignal = typeof mapSignal === "function" ? mapSignal() : mapSignal;
    const requestSignal = requestController.signal;
    if (scopeSignal.aborted || requestSignal.aborted) { report("aborted"); throw abortError(); }
    const controller = new AbortController();
    const abort = () => controller.abort();
    scopeSignal.addEventListener("abort", abort, { once: true });
    requestSignal.addEventListener("abort", abort, { once: true });
    try {
      // A synchronous observer can cancel while a request is being registered.
      if (scopeSignal.aborted || requestSignal.aborted) controller.abort();
      if (controller.signal.aborted) throw abortError();
      const response = await readProtocol(parameters, controller);
      if (controller.signal.aborted) throw abortError();
      let prepared = response;
      if (isEarthTileIndexUrl(parameters.url)) prepared = { ...response, data: prepareEarthTileIndex(response.data) };
      else if (response.data instanceof ArrayBuffer && isEarthVectorTileUrl(parameters.url)) {
        // Only the worker copy is decorated; cached provider bytes stay intact.
        prepared = { ...response, data: appendEarthTileBase(response.data) };
      }
      report("completed");
      return prepared;
    } catch (error) {
      report(controller.signal.aborted || error instanceof Error && error.name === "AbortError" ? "aborted"
        : error instanceof Error && error.name === "TimeoutError" ? "timeout" : "error");
      throw error;
    } finally {
      scopeSignal.removeEventListener("abort", abort);
      requestSignal.removeEventListener("abort", abort);
    }
  };
}
