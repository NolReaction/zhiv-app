import { useId } from "react";
import { KeyRound, MailCheck, Trophy } from "lucide-react";
import type { GameAchievementId } from "@/lib/game-api";

/** Existing enamel medal frame, with the same trusted icon vocabulary as account security. */
export function AchievementMedal({ id, className }: { id: GameAchievementId; className?: string }) {
  const uid = useId().replaceAll(":", "");
  if (id !== "linked_email" && id !== "saved_recovery_code" && id !== "ten_thousand_series") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={className} src={`/achievements/${id}.svg`} width={80} height={80} alt="" />;
  }
  const Icon = id === "linked_email" ? MailCheck : id === "ten_thousand_series" ? Trophy : KeyRound;
  return <svg className={className} viewBox="0 0 96 96" fill="none" aria-hidden="true">
    <defs>
      <radialGradient id={`${uid}-enamel`} cx=".4" cy=".3" r=".75">
        <stop stopColor={id === "linked_email" ? "#365C4C" : "#645234"} /><stop offset="1" stopColor="#202B20" />
      </radialGradient>
      <linearGradient id={`${uid}-edge`} x1="0" y1="0" x2=".7" y2="1">
        <stop stopColor={id === "linked_email" ? "#DEF9CE" : "#F6E4AB"} /><stop offset=".48" stopColor={id === "linked_email" ? "#89B699" : "#CBA660"} /><stop offset="1" stopColor="#496844" />
      </linearGradient>
    </defs>
    <circle cx="48" cy="48" r="42" fill={`url(#${uid}-enamel)`} stroke={`url(#${uid}-edge)`} strokeWidth="2" />
    <circle cx="48" cy="48" r="36.5" stroke="#DBFCA5" strokeOpacity=".15" />
    <path d="M23 25a33 33 0 0 1 34-8" stroke="#F1FFD7" strokeOpacity=".24" strokeWidth="2" strokeLinecap="round" />
    <Icon x="25" y="27" width="46" height="46" color="#0C170F" opacity=".35" strokeWidth="1.8" />
    <Icon x="25" y="25" width="46" height="46" stroke={`url(#${uid}-edge)`} strokeWidth="1.8" />
    <circle cx="24" cy="27" r="2" fill="#EDFCCA" /><circle cx="72" cy="69" r="2" fill="#BCDF8C" />
  </svg>;
}
