import { TAG_COLORS, type PlayerTag } from "@/lib/player-tag";
import styles from "./player-name.module.css";

export function PlayerName({ name, tag }: { name: string | undefined; tag?: PlayerTag | null }) {
  return <>{name}{tag && <span className={styles.tag} style={{ color: TAG_COLORS[tag.color].value }} title="Тег выдан администратором"> [{tag.text}]</span>}</>;
}
