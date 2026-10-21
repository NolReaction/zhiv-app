import type { HabitatScene, SceneOptions } from "@/features/mochlik/scene";
import type { WorldDevSceneRequest } from "@/features/world/dev/forest-scene-preview";
import { rehearsalSceneOptions } from "@/features/world/dev/forest-scene-rehearsal";

/** An ephemeral forest parks the account canvas instead of undoing real jobs. */
export function createMapSceneRehearsal(input: {
  natural: HabitatScene;
  mount: (canvas: HTMLCanvasElement, options: SceneOptions, callbacks: {
    ready: () => void; failure: (error?: unknown) => void; rendered: () => void; activity: () => void;
  }) => HabitatScene;
  select: (scene: HabitatScene, request: WorldDevSceneRequest | null) => void;
  rendered: () => void;
  failed: (id: number) => void;
}) {
  let disposed = false, generation = 0, preview: HabitatScene | null = null;
  let request: WorldDevSceneRequest | null = null, options: SceneOptions | null = null, backgrounded = true;
  let selected = false;
  function remove() {
    generation++; preview?.dispose(); preview = null;
    if (selected) input.select(input.natural, null);
    selected = false;
  }
  return {
    configure(next: SceneOptions, selection: WorldDevSceneRequest | null | undefined, hidden: boolean) {
      if (disposed) return;
      options = { ...next, view: "world" }; backgrounded = hidden;
      if (!selection) {
        if (request) { remove(); request = null; }
        input.natural.configure({ ...options, backgrounded });
        return;
      }
      // A failed asset load stays failed until the user starts a new request.
      // Visibility/configuration changes must not retry it or park the account.
      if (request?.id === selection.id && !preview) {
        input.natural.configure({ ...options, backgrounded });
        return;
      }
      input.natural.configure({ ...options, backgrounded: true });
      if (request?.id === selection.id) {
        preview?.configure({ ...rehearsalSceneOptions(options, request), backgrounded });
        return;
      }
      remove(); request = selection;
      const version = generation;
      const mounted: HabitatScene = input.mount(document.createElement("canvas"), { ...rehearsalSceneOptions(options, request), backgrounded }, {
        activity() {},
        ready() {
          queueMicrotask(() => {
            if (disposed || version !== generation || !request || !options) return;
            selected = true; input.select(mounted, request);
            mounted.configure({ ...rehearsalSceneOptions(options, request), backgrounded });
          });
        },
        failure() {
          if (disposed || version !== generation || !request) return;
          input.failed(request.id);
          remove();
          if (options) input.natural.configure({ ...options, backgrounded });
        },
        rendered() { if (selected && !disposed && version === generation) input.rendered(); },
      });
      preview = mounted;
    },
    dispose() {
      if (disposed) return;
      disposed = true; generation++; preview?.dispose(); preview = null;
      input.natural.dispose(); request = null;
    },
  };
}
