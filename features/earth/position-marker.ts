import { pixelSprite } from "@/features/mochlik/pixel-sprite";
import styles from "./position-marker.module.css";

const portraits = new WeakMap<HTMLElement, HTMLCanvasElement>();

/** A screen-sized pin: MapLibre owns its placement and globe occlusion. */
export function createEarthPositionMarker(): HTMLButtonElement {
  const marker = document.createElement("button");
  marker.type = "button";
  marker.className = styles.marker;
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
    // The rig caches its canvas for the game. Copy it, never reparent it or
    // start a second game loop to paint a small map portrait.
    context.drawImage(pixelSprite("idle", "front", 0), 0, 0);
    portrait.append(canvas);
    portraits.set(marker, canvas);
  } catch {
    const fallback = document.createElement("span");
    fallback.className = styles.fallback;
    fallback.textContent = "🌱";
    portrait.append(fallback);
  }
  marker.append(portrait);
  return marker;
}

/** Only short user reactions repaint; camera movement transforms the portrait. */
export function paintEarthPositionMarkerPose(marker: HTMLElement, pose: "idle" | "greet", frame = 0): void {
  const canvas = portraits.get(marker);
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(pixelSprite(pose, "front", frame), 0, 0);
}

export function updateEarthPositionMarkerLabel(marker: HTMLElement, accuracy?: number): void {
  const precision = accuracy !== undefined && Number.isFinite(accuracy) && accuracy >= 0
    ? accuracy < 1_000
      ? `${Math.max(1, Math.round(accuracy))} м`
      : `${(accuracy / 1_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км`
    : null;
  const label = `Вы здесь${precision ? ` · точность ±${precision}` : ""}`;
  marker.setAttribute("aria-label", `${label}. Поздороваться с Мохликом`);
  marker.title = `${label} · нажмите на Мохлика`;
}
