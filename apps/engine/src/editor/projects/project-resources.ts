import type { ImageAsset } from "@/packages/engine/src/assets/image-assets";
import type { SceneDocument } from "@/packages/engine/src/scene/document";

const PNG_PREFIX = "data:image/png;base64,";
export type StoredAsset = Omit<ImageAsset, "dataUrl"> & { resourceKey: string };
export type StoredDocument = Omit<SceneDocument, "assets"> & { assets: StoredAsset[] };
export type ProjectResource = { key: string; contentId: string; byteLength: number; blob: Blob };
export type PreparedProject = { document: StoredDocument; resources: ProjectResource[] };

export function pngDataUrlBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  if (!dataUrl.startsWith(PNG_PREFIX)) throw new Error("Ресурс проекта должен быть PNG.");
  const encoded = dataUrl.slice(PNG_PREFIX.length), binary = atob(encoded);
  if (btoa(binary) !== encoded) throw new Error("Некорректное содержимое PNG.");
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function pngBytesDataUrl(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return PNG_PREFIX + btoa(binary);
}

export async function contentKey(bytes: Uint8Array<ArrayBuffer>, subtle?: SubtleCrypto): Promise<string> {
  const cryptography = subtle ?? globalThis.crypto?.subtle;
  if (!cryptography) throw new Error("Для сохранения PNG открой редактор через HTTPS или localhost. Текущую сцену можно скачать как JSON.");
  const digest = await cryptography.digest("SHA-256", bytes);
  return "sha256:" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** A small resource-only cache avoids decoding and hashing an unchanged PNG on every edit. */
export function createProjectResourceCodec(subtle?: SubtleCrypto) {
  const cache = new Map<string, ProjectResource>();
  let cachedBytes = 0;
  return {
    async prepare(document: SceneDocument): Promise<PreparedProject> {
      const assets: StoredAsset[] = [], resources: ProjectResource[] = [];
      for (const asset of document.assets) {
        let resource = cache.get(asset.dataUrl);
        if (!resource) {
          const bytes = pngDataUrlBytes(asset.dataUrl), key = await contentKey(bytes, subtle);
          resource = { key, contentId: asset.id, byteLength: bytes.length, blob: new Blob([bytes], { type: "image/png" }) };
          cache.set(asset.dataUrl, resource);
          cachedBytes += resource.byteLength;
          while (cache.size > 32 || cachedBytes > 16 * 1024 * 1024) {
            const oldest = cache.keys().next().value!;
            cachedBytes -= cache.get(oldest)!.byteLength;
            cache.delete(oldest);
          }
        } else if (resource.contentId !== asset.id) throw new Error("ID изображения не соответствует его содержимому.");
        assets.push({ id: asset.id, name: asset.name, width: asset.width, height: asset.height, resourceKey: resource.key });
        resources.push(resource);
      }
      return { document: { ...structuredClone(document), assets }, resources };
    },
    clear() { cache.clear(); cachedBytes = 0; },
  };
}

/** Restore the original PNG bytes, without canvas decoding or re-encoding. */
export async function restoreProjectResources(document: StoredDocument, resources: ReadonlyMap<string, ProjectResource>, subtle?: SubtleCrypto): Promise<SceneDocument> {
  const assets: ImageAsset[] = [];
  for (const asset of document.assets) {
    const resource = resources.get(asset.resourceKey);
    if (!resource || !(resource.blob instanceof Blob) || resource.blob.type !== "image/png"
      || resource.blob.size !== resource.byteLength || resource.contentId !== asset.id) throw new Error(`Ресурс «${asset.name}» отсутствует или повреждён.`);
    const bytes = new Uint8Array(await resource.blob.arrayBuffer());
    if (await contentKey(bytes, subtle) !== asset.resourceKey) throw new Error(`Содержимое «${asset.name}» повреждено.`);
    assets.push({ id: asset.id, name: asset.name, width: asset.width, height: asset.height, dataUrl: pngBytesDataUrl(bytes) });
  }
  return { ...structuredClone(document), assets };
}
