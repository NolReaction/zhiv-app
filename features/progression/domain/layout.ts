import { progressionLocations, type ProgressionGraph } from "./graph";

export const NODE_WIDTH = 148;
export const NODE_HEIGHT = 104;
export const COLUMN_WIDTH = 544;
export const phaseTitles = ["Начало и места на карте", "Дом 1 · первые производства", "Дом 2 · шахта, печь и рынок", "Дом 3 · стройматериалы", "Дом 4 · инструменты", "Дом 5 · крупные партии", "Живая поляна и коллекции", "Расширение мира · план"];

export type ProgressionLayout = {
  positions: Map<string, { x: number; y: number }>;
  sections: { phase: number; x: number; y: number; width: number; height: number }[];
  groups: { phase: number; locationId: string; title: string; x: number; y: number; width: number; height: number }[];
  width: number;
  height: number;
};

/** Preserve the workbench columns, while grouping improvements by their existing map object. */
export function buildProgressionLayout(graph: ProgressionGraph): ProgressionLayout {
  const positions: ProgressionLayout["positions"] = new Map();
  const sections: ProgressionLayout["sections"] = [];
  const groups: ProgressionLayout["groups"] = [];
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  for (let phase = 0; phase < phaseTitles.length; phase += 1) {
    const x = 36 + phase * COLUMN_WIDTH;
    let bottom = 98;
    if (phase >= 1 && phase <= 5) {
      for (const location of progressionLocations) {
        const buildings = graph.nodes.filter(node => node.kind === "building" && node.locationId === location.id && node.phase === phase);
        if (!buildings.length) continue;
        const top = bottom;
        bottom += 32;
        for (const building of buildings) {
          positions.set(building.id, { x: x + 184, y: bottom });
          bottom += NODE_HEIGHT + 20;
          const recipes = building.children.map(id => byId.get(id)).filter(node => node?.phase === phase);
          recipes.forEach((node, index) => {
            const rowSize = Math.min(3, recipes.length - Math.floor(index / 3) * 3);
            positions.set(node!.id, { x: x + 18 + index % 3 * 166 + (3 - rowSize) * 83, y: bottom + Math.floor(index / 3) * 124 });
          });
          bottom += Math.ceil(recipes.length / 3) * 124 + 24;
        }
        groups.push({ phase, locationId: location.id, title: location.title, x: x + 6, y: top - 10, width: COLUMN_WIDTH - 38, height: bottom - top + 8 });
        bottom += 28;
      }
      // Custom catalog buildings, recipes with extra gates and exploration stay visible.
      const extra = graph.nodes.filter(node => node.phase === phase && !positions.has(node.id));
      extra.forEach((node, index) => positions.set(node.id, { x: x + 18 + index % 3 * 166, y: bottom + Math.floor(index / 3) * 132 }));
      bottom += Math.ceil(extra.length / 3) * 132;
    } else {
      const nodes = graph.nodes.filter(node => node.phase === phase);
      nodes.forEach((node, index) => positions.set(node.id, { x: x + 18 + index % 3 * 166, y: bottom + Math.floor(index / 3) * 164 }));
      bottom += Math.ceil(nodes.length / 3) * 164;
    }
    sections.push({ phase, x, y: 34, width: COLUMN_WIDTH - 26, height: bottom + 40 });
  }
  return { positions, sections, groups, width: COLUMN_WIDTH * phaseTitles.length + 72, height: Math.max(...sections.map(section => section.height)) + 80 };
}
