import { assertPngDataUrl } from "@/packages/engine/src/assets/image-assets";
import type { SceneDocument } from "@/packages/engine/src/scene/document";
import { createProjectId, parseProjectDocument } from "./project-document";

type ProjectImportOptions = {
  assertAsset?: (dataUrl: string) => Promise<void>;
  isCurrent?: () => boolean;
};

/** Prepare all resources before the caller activates or saves a new project. */
export async function prepareProjectImport(json: string, options: ProjectImportOptions = {}): Promise<SceneDocument> {
  const ensureCurrent = () => {
    if (options.isCurrent && !options.isCurrent()) throw new DOMException("Импорт проекта отменён.", "AbortError");
  };
  ensureCurrent();
  const document = parseProjectDocument(json);
  if (!document) throw new Error("JSON проекта не прошёл проверку: проверь формат, шаблон сцены и исходные PNG.");
  const assertAsset = options.assertAsset ?? assertPngDataUrl;
  // One PNG at a time bounds the decompression working set for large imports.
  for (const asset of document.assets) {
    ensureCurrent();
    try { await assertAsset(asset.dataUrl); }
    catch (cause) {
      ensureCurrent();
      throw new Error(`Не удалось открыть PNG «${asset.name}»: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    ensureCurrent();
  }
  ensureCurrent();
  document.id = createProjectId();
  return document;
}
