import type { GameAchievementId } from "./game-api";

/** All six medals are editable SVG assets; locked colors are controlled by CSS. */
export function AchievementMedal({ id, className }: { id: GameAchievementId; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={className} src={`/achievements/${id}.svg`} width={80} height={80} alt="" />;
}
