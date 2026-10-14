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
  function destination(id: string): StudioFolder {
    const existing = folders.get(id); if (existing) return existing;
    if (id.startsWith("custom:")) {
      const segments = id.slice(7).split("/"); let parent: StudioFolder | undefined;
      for (let at = 0; at < segments.length; at++) parent = folder(`custom:${segments.slice(0, at + 1).join("/")}`, segments[at], parent);
      return parent!;
    }
    const building = /^building:([^:]+)(?::(\d+))?$/.exec(id);
    if (building) {
      const siteId = building[1], level = building[2] === undefined ? undefined : Number(building[2]);
      const site = TILED_WORLD.sites.find(item => item.id === siteId);
      const parent = folder(`building:${siteId}`, site?.label ?? siteId, folder("buildings", "Здания"));
      if (level === undefined) return parent;
      const active = levels[siteId] === level;
      return folder(id, `Уровень ${level}${active ? " · на карте" : ""}`, parent, active);
    }
    if (id.startsWith("tree:")) return folder(id, treeName(id.slice(5)), folder("trees", "Деревья"));
    const labels: Record<string, string> = { buildings: "Здания", trees: "Деревья", stones: "Камни", volumes: "Свои объёмы", surfaces: "Поверхности земли", lights: "Источники света", removed: "Удалённые / выключенные" };
    return folder(id, labels[id] ?? id);
  }
  function naturalCasterFolder(caster: WorldLightingEditorSnapshot["casters"][number]) {
    if (caster.when) return destination(`building:${caster.when.siteId}:${caster.when.level}`);
    if (/-(trunk|crown)$/.test(caster.id)) return destination(`tree:${caster.id.replace(/-(trunk|crown)$/, "")}`);
    return destination(/boulder|stone|rock/.test(caster.id) ? "stones" : "volumes");
  }
  // Keep automatic destinations available when their objects have been moved.
  for (const caster of snapshot.casters) naturalCasterFolder(caster);
  if (snapshot.receivers.length) destination("surfaces");
  if (snapshot.lights.some(light => light.enabled !== false)) destination("lights");
  for (const caster of snapshot.casters) {
    const parent = caster.studioFolder ? destination(caster.studioFolder) : naturalCasterFolder(caster);
    const site = caster.when ? TILED_WORLD.sites.find(item => item.id === caster.when!.siteId) : undefined;
    parent.children.push({ type: "object", kind: "caster", id: caster.id,
      label: caster.studioName ?? (caster.when ? "Объём здания" : /-trunk$/.test(caster.id) ? "Ствол" : /-crown$/.test(caster.id) ? "Крона" : caster.id === "clearing-boulder" ? "Камень на поляне" : caster.id),
      detail: `Отбрасывает тень${caster.when ? ` · ${site?.label ?? caster.when.siteId} · уровень ${caster.when.level}${levels[caster.when.siteId] === caster.when.level ? " · на карте" : ""}` : ""}`,
      dirty: snapshot.dirtyIds.includes(caster.id), removed: false });
  }
  for (const receiver of snapshot.receivers) destination(receiver.studioFolder ?? "surfaces").children.push({ type: "object", kind: "receiver", id: receiver.id, label: receiver.studioName ?? studioReceiverName(receiver.id), detail: "Принимает тени", dirty: snapshot.dirtyReceiverIds.includes(receiver.id), removed: false });
  for (const light of snapshot.lights) {
    const removed = light.enabled === false;
    destination(removed ? "removed" : light.studioFolder ?? "lights").children.push({ type: "object", kind: "light", id: light.id, label: light.studioName ?? studioSourceName(light.id, light.kind), detail: removed ? "Источник выключен" : "Источник света", dirty: snapshot.dirtyLightIds.includes(light.id), removed });
  }
  for (const [kind, deleted] of [["caster", snapshot.deletedCasters], ["receiver", snapshot.deletedReceivers]] as const) {
    for (const element of deleted) destination("removed").children.push({ type: "object", kind, id: element.id, label: element.studioName ?? (kind === "receiver" ? studioReceiverName(element.id) : element.id), detail: kind === "receiver" ? "Поверхность удалена" : "Объём тени удалён", dirty: true, removed: true });
  }
  return roots;
}

export function studioFolderOptions(nodes: readonly StudioNode[], prefix = ""): { id: string; label: string }[] {
  return nodes.flatMap(node => {
    if (node.type !== "folder" || node.id === "removed") return [];
    const label = prefix ? `${prefix} / ${node.label}` : node.label;
    return [{ id: node.id, label }, ...studioFolderOptions(node.children, label)];
  });
}

/** Selection ranges follow the rows the user can actually see, including active search results. */
export function studioVisibleObjects(nodes: readonly StudioNode[], expanded: ReadonlySet<string>, searching = false): StudioObject[] {
  return nodes.flatMap(node => node.type === "object" ? node.removed ? [] : [node]
    : searching || expanded.has(node.id) ? studioVisibleObjects(node.children, expanded, searching) : []);
}
export function studioSelectionRange(nodes: readonly StudioObject[], anchor: { kind: WorldLightingElementKind; id: string } | null, target: StudioObject) {
  const end = nodes.findIndex(node => node.kind === target.kind && node.id === target.id), start = anchor ? nodes.findIndex(node => node.kind === anchor.kind && node.id === anchor.id) : end;
  return start < 0 || end < 0 ? [target] : nodes.slice(Math.min(start, end), Math.max(start, end) + 1);
}

export function filterWorldStudioOutliner(nodes: readonly StudioNode[], query: string, filter: StudioObjectFilter): StudioNode[] {
  const needle = query.trim().toLocaleLowerCase("ru");
  function visit(items: readonly StudioNode[], ancestors: string): StudioNode[] {
    return items.flatMap<StudioNode>(node => {
      if (node.type === "folder") { const children = visit(node.children, `${ancestors} ${node.label}`); return children.length || !needle && filter === "all" ? [{ ...node, children }] : []; }
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
    ...(node.id === "buildings" || node.id.startsWith("building:") && !/:[0-9]+$/.test(node.id) || node.id.startsWith("custom:") || node.active ? [node.id] : []),
    ...studioDefaultFolders(node.children),
  ]);
}
