import type { GameAchievementId } from "./game-api";

/** Locked colors are controlled by the surrounding achievement styles. */
export function AchievementMedal({ id, className }: { id: GameAchievementId; className?: string }) {
  const collection = id === "full_collection";
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={className} src={`/achievements/${id}.${collection ? "png" : "svg"}`} style={collection ? { clipPath: "circle(45% at 50% 50%)" } : undefined} width={80} height={80} alt="" />;
}
