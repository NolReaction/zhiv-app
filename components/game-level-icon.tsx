import { Sprout, Flame, Compass, Map, Trees, Gem, Zap, Star, Shield, Crown } from "lucide-react";
import { getClickerIconStage } from "@/lib/clicker-story";

const ICONS = [Sprout, Flame, Compass, Map, Trees, Gem, Zap, Star, Shield, Crown];
const COLORS = ["#b6d79b", "#efb366", "#d8cc86", "#90c9a9", "#80c798", "#83c9d1", "#bdd0f2", "#c4b1e9", "#ecc392", "#ffe395"];
export function GameLevelIcon({ level, size = 20 }: { level: number; size?: number }) {
  const stage = getClickerIconStage(level), Icon = ICONS[stage];
  return <Icon size={size} color={COLORS[stage]} aria-hidden="true" />;
}
