import type { AddProtocolAction } from "maplibre-gl";
import { appendEarthTileBase, isEarthTileIndexUrl, isEarthVectorTileUrl, prepareEarthTileIndex } from "./tile-base";

function abortError(): DOMException { return new DOMException("Map request cancelled", "AbortError"); }

/**
 * Tile requests belong to both their SDK request and the map that started them.
 * Worker teardown must not leave a cache consumer holding a network queue slot
 * when the SDK does not cancel its custom-protocol controller on map removal.
 * The shared runtime installation deliberately does not use this protocol.
 */
export function createEarthResourceProtocol(readProtocol: AddProtocolAction, mapSignal: AbortSignal): AddProtocolAction {
  return async (parameters, requestController) => {
    const requestSignal = requestController.signal;
    if (mapSignal.aborted || requestSignal.aborted) throw abortError();
    const controller = new AbortController();
    const abort = () => controller.abort();
    mapSignal.addEventListener("abort", abort, { once: true });
    requestSignal.addEventListener("abort", abort, { once: true });
    try {
      // A synchronous observer can cancel while a request is being registered.
      if (mapSignal.aborted || requestSignal.aborted) controller.abort();
      if (controller.signal.aborted) throw abortError();
      const response = await readProtocol(parameters, controller);
      if (controller.signal.aborted) throw abortError();
      if (isEarthTileIndexUrl(parameters.url)) return { ...response, data: prepareEarthTileIndex(response.data) };
      if (response.data instanceof ArrayBuffer && isEarthVectorTileUrl(parameters.url)) {
        // Only the worker copy is decorated; cached provider bytes stay intact.
        return { ...response, data: appendEarthTileBase(response.data) };
      }
      return response;
    } finally {
      mapSignal.removeEventListener("abort", abort);
      requestSignal.removeEventListener("abort", abort);
    }
  };
}
