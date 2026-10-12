import { wardrobeItems } from "@/features/world/domain/wardrobe";
import { z } from "zod";
import { economyCatalog, economyCommandSchema } from "@/features/economy/domain/model";

/** Separate from player commands: only the local development API accepts these. */
export const economyDevCommandSchema = z.object({
  requestId: economyCommandSchema.shape.requestId,
  ownerPublicId: economyCommandSchema.shape.ownerPublicId,
  expectedRevision: economyCommandSchema.shape.expectedRevision,
  action: z.enum(["grant_currency", "grant_item", "grant_fishing_gear", "grant_wardrobe", "grant_upgrade_cost", "set_building_level", "finish_jobs", "apply_settlement"]),
  targetId: economyCommandSchema.shape.targetId,
  quantity: z.number().int().min(0).max(10_000_000).default(1),
  totalPrice: z.literal(0).default(0),
}).strict().superRefine((command, context) => {
  const invalid = (path: "targetId" | "quantity") => context.addIssue({ code: "custom", path: [path], message: "Недопустимое значение для DEV-команды" });
  if (command.action === "grant_currency" || command.action === "grant_item") {
    if (command.quantity < 1 || (command.action === "grant_item" && command.quantity > 1_000_000)) invalid("quantity");
    if (command.action === "grant_currency" ? !["coins", "pearls"].includes(command.targetId)
      : !economyCatalog.items.some(item => item.id === command.targetId)) invalid("targetId");
  } else if (command.action === "grant_wardrobe") {
    if (command.quantity !== 1) invalid("quantity");
    if (command.targetId !== "all" && !wardrobeItems.some(item => item.id === command.targetId)) invalid("targetId");
  } else if (command.action === "grant_fishing_gear") {
    if (command.quantity !== 1) invalid("quantity");
    if (command.targetId !== "all" && !economyCatalog.fishing?.rods.some(rod => rod.id === command.targetId)
      && !economyCatalog.fishing?.hooks.some(hook => hook.id === command.targetId)) invalid("targetId");
  } else if (command.action === "apply_settlement") {
    if (command.targetId !== "home") invalid("targetId");
    if (!economyCatalog.buildings.find(building => building.id === "home")!.levels.some(level => level.level === command.quantity)) invalid("quantity");
  } else if (command.action === "finish_jobs") {
    if (!["all", "construction", "production", "exploration"].includes(command.targetId)) invalid("targetId");
    if (command.quantity !== 1) invalid("quantity");
  } else {
    const building = economyCatalog.buildings.find(item => item.id === command.targetId);
    if (!building) invalid("targetId");
    if (command.action === "grant_upgrade_cost") {
      if (command.quantity !== 1) invalid("quantity");
    } else if (building) {
      const minimum = ["home", "warehouse"].includes(building.id) ? 1 : 0;
      if (command.quantity < minimum || (command.quantity !== 0 && !building.levels.some(level => level.level === command.quantity))) invalid("quantity");
    }
  }
});

export type EconomyDevCommand = z.infer<typeof economyDevCommandSchema>;
