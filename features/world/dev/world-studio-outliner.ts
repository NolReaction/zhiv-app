import { TILED_WORLD } from "@/features/world/scene/presentation";
import type { WorldLightingEditorSnapshot, WorldLightingElementKind } from "./world-lighting-editor-store";

export type StudioObjectFilter = "all" | "casters" | "lights" | "receivers" | "changed";
export type StudioObject = { type: "object"; kind: WorldLightingElementKind; id: string; label: string; detail: string; dirty: boolean; removed: boolean };
export type StudioFolder = { type: "folder"; id: string; label: string; children: StudioNode[]; active?: boolean };
export type StudioNode = StudioObject | StudioFolder;

export function studioSourceName(id: string, kind: string) {
  const names: Record<string, string> = { "home-lantern": "Фонарь дома", "clearing-torch": "Факел на поляне",
    "quarry-torch-1": "Факел у шахты", "north-fork-torch": "Северная развилка", "river-path-torch": "Дорожка у реки",
    "bridge-torch-right": "Факел у моста", "plesk-torch-1": "Факел у Плёски" };
  return names[id] ?? `${kind === "lantern" ? "Фонарь" : kind === "torch" ? "Факел" : "Свечение"} · ${id}`;
}
export function studioReceiverName(id: string) {
  const names: Record<string, string> = { "clearing-west-ground": "Земля · запад поляны", "clearing-front-ground": "Земля · передний план", "clearing-east-ground": "Земля · восток поляны" };
  return names[id] ?? `Поверхность · ${id}`;
}
function treeName(id: string) {
  return ({ "clearing-north": "Северное дерево", "clearing-west": "Западное дерево" } as Record<string, string>)[id] ?? id;
}

export function buildWorldStudioOutliner(snapshot: Pick<WorldLightingEditorSnapshot, "casters" | "receivers" | "lights" | "dirtyIds" | "dirtyLightIds" | "dirtyReceiverIds" | "deletedCasters" | "deletedReceivers">, levels: Readonly<Record<string, number>>) {
  const roots: StudioNode[] = [], folders = new Map<string, StudioFolder>();
  function folder(id: string, label: string, parent?: StudioFolder, active?: boolean) {
    let node = folders.get(id);
    if (!node) { node = { type: "folder", id, label, children: [], active }; folders.set(id, node); (parent?.children ?? roots).push(node); }
    return node;
  }
  for (const caster of snapshot.casters) {
    let parent: StudioFolder;
    if (caster.when) {
      const site = TILED_WORLD.sites.find(item => item.id === caster.when!.siteId);
      const buildings = folder("buildings", "Здания");
      const building = folder(`building:${caster.when.siteId}`, site?.label ?? caster.when.siteId, buildings);
      const active = levels[caster.when.siteId] === caster.when.level;
      parent = folder(`building:${caster.when.siteId}:${caster.when.level}`, `Уровень ${caster.when.level}${active ? " · на карте" : ""}`, building, active);
    } else if (/-(trunk|crown)$/.test(caster.id)) {
      const stem = caster.id.replace(/-(trunk|crown)$/, "");
      parent = folder(`tree:${stem}`, treeName(stem), folder("trees", "Деревья"));
    } else parent = /boulder|stone|rock/.test(caster.id) ? folder("stones", "Камни") : folder("volumes", "Свои объёмы");
    parent.children.push({ type: "object", kind: "caster", id: caster.id,
      label: caster.when ? "Объём здания" : /-trunk$/.test(caster.id) ? "Ствол" : /-crown$/.test(caster.id) ? "Крона" : caster.id === "clearing-boulder" ? "Камень на поляне" : caster.id,
      detail: "Отбрасывает тень", dirty: snapshot.dirtyIds.includes(caster.id), removed: false });
  }
  for (const receiver of snapshot.receivers) folder("surfaces", "Поверхности земли").children.push({ type: "object", kind: "receiver", id: receiver.id, label: studioReceiverName(receiver.id), detail: "Принимает тени", dirty: snapshot.dirtyReceiverIds.includes(receiver.id), removed: false });
  for (const light of snapshot.lights) {
    const removed = light.enabled === false;
    folder(removed ? "removed" : "lights", removed ? "Удалённые / выключенные" : "Источники света").children.push({ type: "object", kind: "light", id: light.id, label: studioSourceName(light.id, light.kind), detail: removed ? "Источник выключен" : "Источник света", dirty: snapshot.dirtyLightIds.includes(light.id), removed });
  }
  for (const [kind, deleted] of [["caster", snapshot.deletedCasters], ["receiver", snapshot.deletedReceivers]] as const) {
    for (const element of deleted) folder("removed", "Удалённые / выключенные").children.push({ type: "object", kind, id: element.id, label: kind === "receiver" ? studioReceiverName(element.id) : element.id, detail: kind === "receiver" ? "Поверхность удалена" : "Объём тени удалён", dirty: true, removed: true });
  }
  return roots;
}

export function filterWorldStudioOutliner(nodes: readonly StudioNode[], query: string, filter: StudioObjectFilter): StudioNode[] {
  const needle = query.trim().toLocaleLowerCase("ru");
  function visit(items: readonly StudioNode[], ancestors: string): StudioNode[] {
    return items.flatMap<StudioNode>(node => {
      if (node.type === "folder") { const children = visit(node.children, `${ancestors} ${node.label}`); return children.length ? [{ ...node, children }] : []; }
      const matchesKind = filter === "all" || filter === "changed" && node.dirty || filter === "casters" && node.kind === "caster" || filter === "lights" && node.kind === "light" || filter === "receivers" && node.kind === "receiver";
      return matchesKind && (!needle || `${ancestors} ${node.label} ${node.id} ${node.detail}`.toLocaleLowerCase("ru").includes(needle)) ? [node] : [];
    });
  }
  return visit(nodes, "");
}
export function studioFolderAncestors(nodes: readonly StudioNode[], kind: WorldLightingElementKind, id: string): string[] {
  for (const node of nodes) {
    if (node.type === "object") { if (node.kind === kind && node.id === id) return []; }
    else if (node.children.some(child => child.type === "object" && child.kind === kind && child.id === id)) return [node.id];
    else { const path = studioFolderAncestors(node.children, kind, id); if (path.length) return [node.id, ...path]; }
  }
  return [];
}
export function studioDefaultFolders(nodes: readonly StudioNode[]): string[] {
  return nodes.flatMap(node => node.type === "object" ? [] : [
    ...(node.id === "buildings" || node.id.startsWith("building:") && !/:[0-9]+$/.test(node.id) || node.active ? [node.id] : []),
    ...studioDefaultFolders(node.children),
  ]);
}
