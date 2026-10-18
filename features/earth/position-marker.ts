import { pixelSprite } from "@/features/mochlik/pixel-sprite";
import styles from "./position-marker.module.css";

/** A screen-sized pin: MapLibre owns its placement and globe occlusion. */
export function createEarthPositionMarker(): HTMLDivElement {
  const marker = document.createElement("div");
  marker.className = styles.marker;
  marker.setAttribute("role", "img");
  updateEarthPositionMarkerLabel(marker);

  const portrait = document.createElement("span");
  portrait.className = styles.portrait;
  portrait.setAttribute("aria-hidden", "true");
  const canvas = document.createElement("canvas");
  canvas.className = styles.sprite;
  canvas.width = 48;
  canvas.height = 48;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas unavailable");
    context.imageSmoothingEnabled = false;
    // The rig caches its canvas for the game. Copy it once, never reparent it or
    // start a second game/animation loop to paint a stationary map portrait.
    context.drawImage(pixelSprite("idle", "front", 0), 0, 0);
    portrait.append(canvas);
  } catch {
    const fallback = document.createElement("span");
    fallback.className = styles.fallback;
    fallback.textContent = "🌱";
    portrait.append(fallback);
  }
  marker.append(portrait);
  return marker;
}

export function updateEarthPositionMarkerLabel(marker: HTMLElement, accuracy?: number): void {
  const precision = accuracy !== undefined && Number.isFinite(accuracy) && accuracy >= 0
    ? accuracy < 1_000
      ? `${Math.max(1, Math.round(accuracy))} м`
      : `${(accuracy / 1_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км`
    : null;
  const label = `Вы здесь${precision ? ` · точность ±${precision}` : ""}`;
  marker.setAttribute("aria-label", label);
  marker.title = label;
}
