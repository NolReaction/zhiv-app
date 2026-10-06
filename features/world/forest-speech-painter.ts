import type { ForestSpeechFrame } from "./forest-social";

/** Screen-space CSS pixels: the camera supplies the visible speaker's head anchor. */
export type ForestSpeechCanvasFrame = ForestSpeechFrame & { anchor: Readonly<{ x: number; y: number }> };
export type ForestSpeechViewport = {
  width: number;
  height: number;
  insets?: Partial<Record<"top" | "right" | "bottom" | "left", number>>;
  reducedMotion?: boolean;
  night?: boolean;
};
export type ForestSpeechLayout = {
  id: string;
  speaker: ForestSpeechFrame["speaker"];
  label: string;
  lines: readonly string[];
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  tail: { side: "top" | "bottom"; x: number; tipX: number; tipY: number };
};

export const FOREST_SPEECH_FONT = '13px "Iowan Old Style", "Palatino Linotype", Georgia, serif';
const LABEL_FONT = '600 9px ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
const LABELS = { mochlik: "Мохлик", plesk: "Плёска", builder: "Шишколап" } as const;
const INK = { mochlik: "#667847", plesk: "#417d86", builder: "#987044" } as const;
const PADDING = 12, LINE_HEIGHT = 17, LABEL_HEIGHT = 17, MAX_LINES = 3;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

function wrap(text: string, width: number, measure: (text: string) => number): string[] {
  const words = text.replace(/\s+/gu, " ").trim().slice(0, 280).split(" ");
  if (words.length === 1 && !words[0]) return [];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate) <= width) { line = candidate; continue; }
    if (line) { lines.push(line); line = ""; }
    for (const letter of Array.from(word)) {
      if (line && measure(line + letter) > width) { lines.push(line); line = ""; }
      line += letter;
    }
  }
  if (line) lines.push(line);
  if (lines.length > MAX_LINES) {
    lines.length = MAX_LINES;
    let last = Array.from(lines[MAX_LINES - 1]);
    while (last.length && measure(`${last.join("").trimEnd()}…`) > width) last = last.slice(0, -1);
    lines[MAX_LINES - 1] = `${last.join("").trimEnd()}…`;
  }
  return lines;
}

/** Pure layout; never moves a resident, advances speech or mutates its frame. */
export function layoutForestSpeech(frame: ForestSpeechCanvasFrame, viewport: ForestSpeechViewport,
  measure: (text: string) => number): ForestSpeechLayout | null {
  const { width, height } = viewport, { anchor, elapsed, duration } = frame;
  if (![width, height, anchor.x, anchor.y, elapsed, duration].every(Number.isFinite)
    || width <= 0 || height <= 0 || duration <= 0 || elapsed < 0 || elapsed >= duration
    || anchor.x < 0 || anchor.x > width || anchor.y < 0 || anchor.y > height) return null;
  const inset = (side: "top" | "right" | "bottom" | "left") => {
    const value = viewport.insets?.[side];
    return 8 + (Number.isFinite(value) ? Math.max(0, value!) : 0);
  };
  const left = inset("left"), right = width - inset("right"), top = inset("top"), bottom = height - inset("bottom");
  const available = right - left;
  if (available < 92 || bottom - top < 60) return null;
  const contentWidth = Math.min(174, available - PADDING * 2);
  const lines = wrap(frame.text, contentWidth, measure);
  if (!lines.length) return null;
  const boxWidth = Math.min(available, Math.max(104,
    ...lines.map(line => measure(line) + PADDING * 2)));
  const boxHeight = PADDING * 2 + LABEL_HEIGHT + lines.length * LINE_HEIGHT - 3;
  if (boxHeight > bottom - top) return null;
  const entrance = clamp(elapsed / .24, 0, 1);
  const eased = 1 - (1 - entrance) ** 3;
  const opacity = viewport.reducedMotion ? 1 : Math.min(eased, clamp((duration - elapsed) / .32, 0, 1));
  const rise = viewport.reducedMotion ? 0 : (1 - eased) * 4;
  const side = anchor.y - 14 - boxHeight >= top || anchor.y - top >= bottom - anchor.y ? "bottom" : "top";
  const x = clamp(anchor.x - boxWidth / 2, left, right - boxWidth);
  const y = clamp(side === "bottom" ? anchor.y - 14 - boxHeight + rise : anchor.y + 14 - rise, top, bottom - boxHeight);
  const tailX = clamp(anchor.x, x + 20, x + boxWidth - 20);
  return { id: frame.id, speaker: frame.speaker, label: LABELS[frame.speaker], lines,
    x, y, width: boxWidth, height: boxHeight, opacity,
    tail: { side, x: tailX, tipX: clamp(anchor.x, tailX - 12, tailX + 12),
      tipY: side === "bottom" ? y + boxHeight + 7 : y - 7 } };
}

function outline(ctx: CanvasRenderingContext2D, box: ForestSpeechLayout) {
  const { x, y, width: width, height: height, tail } = box, radius = 12;
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  if (tail.side === "top") {
    ctx.lineTo(tail.x - 7, y); ctx.quadraticCurveTo(tail.x - 2, y, tail.tipX, tail.tipY);
    ctx.quadraticCurveTo(tail.x + 2, y, tail.x + 7, y);
  }
  ctx.lineTo(x + width - radius, y); ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius); ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  if (tail.side === "bottom") {
    ctx.lineTo(tail.x + 7, y + height); ctx.quadraticCurveTo(tail.x + 2, y + height, tail.tipX, tail.tipY);
    ctx.quadraticCurveTo(tail.x - 2, y + height, tail.x - 7, y + height);
  }
  ctx.lineTo(x + radius, y + height); ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius); ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/** One bubble at a time. Caller retains the DPR transform, without camera zoom. */
export function drawForestSpeech(ctx: CanvasRenderingContext2D, frames: readonly ForestSpeechCanvasFrame[],
  viewport: ForestSpeechViewport): ForestSpeechLayout | null {
  if (!frames.length) return null;
  ctx.save();
  try {
    ctx.font = FOREST_SPEECH_FONT;
    let box: ForestSpeechLayout | null = null;
    for (const frame of frames) {
      box = layoutForestSpeech(frame, viewport, text => ctx.measureText(text).width);
      if (box) break;
    }
    if (!box || box.opacity <= 0) return box;
    ctx.globalAlpha *= box.opacity;
    ctx.shadowColor = viewport.night ? "rgba(12, 19, 25, .28)" : "rgba(58, 45, 29, .16)";
    ctx.shadowBlur = 10; ctx.shadowOffsetY = 3; ctx.shadowOffsetX = 0;
    ctx.fillStyle = viewport.night ? "#efe8d8" : "#fff8e9";
    outline(ctx, box); ctx.fill();
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.strokeStyle = viewport.night ? "#b5a58b" : "#d1bea0"; ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.font = LABEL_FONT; ctx.fillStyle = INK[box.speaker];
    ctx.fillText(box.label, box.x + PADDING, box.y + PADDING - 1, box.width - PADDING * 2);
    ctx.font = FOREST_SPEECH_FONT; ctx.fillStyle = "#453d30";
    box.lines.forEach((line, index) => ctx.fillText(line, box.x + PADDING,
      box.y + PADDING + LABEL_HEIGHT + index * LINE_HEIGHT, box.width - PADDING * 2));
    return box;
  } finally { ctx.restore(); }
}
