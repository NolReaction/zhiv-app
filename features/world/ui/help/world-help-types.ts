export type WorldHelpTarget =
  | { kind: "pantry" }
  | { kind: "expeditions"; sector?: "forest" | "coast" | "caves" }
  | { kind: "station"; stationId: string; recipeId?: string }
  | { kind: "upgrade"; stationId: string }
  | { kind: "food"; tab?: "meals" | "orders"; residentId?: "plesk" | "builder" }
  | { kind: "resident"; residentId: "plesk" | "builder" }
  | { kind: "profile"; tab?: "profile" | "mood" | "friends" }
  | { kind: "collection" }
  | { kind: "wardrobe" }
  | { kind: "people" }
  | { kind: "retry-economy" }
  | { kind: "retry-world" };

export type WorldHelpContext = {
  stationId?: string;
  recipeId?: string;
  fishItemId?: string;
  quantity?: number;
  routeId?: string;
  intent?: "production" | "construction" | "expedition";
};

export type WorldHelpSuggestion = {
  id: string;
  title: string;
  message: string;
  topicId: string;
  action?: { label: string; target: WorldHelpTarget };
  severity: "problem" | "next";
};
