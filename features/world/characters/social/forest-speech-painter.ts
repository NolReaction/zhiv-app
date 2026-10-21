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

export const FOREST_SPEECH_FONT = '14px "Zhiv Residents", ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
const LABEL_FONT = '600 8.5px ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
const LABELS = { mochlik: "Мохлик", plesk: "Плёска", builder: "Шишколап",
  lopukh: "Лопоух", kamneshmyg: "Камнешмыг", leaftail: "Листохвост" } as const;
const INK = { mochlik: "#667847", plesk: "#417d86", builder: "#987044",
  lopukh: "#94714b", kamneshmyg: "#657887", leaftail: "#947047" } as const;
const PADDING = 10, VERTICAL_PADDING = 8, LINE_HEIGHT = 17, LABEL_HEIGHT = 13, MAX_LINES = 2;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
type SpeechTextLayout = { lines: string[]; widths: number[]; truncated: boolean };
type SpeechTextLayoutReader = (text: string, width: number) => SpeechTextLayout;
const TEXT_LAYOUT_LIMIT = 48, TEXT_MEASURE_LIMIT = 512;
const fontEpochs = new WeakMap<FontFaceSet, { value: number }>();
const textCaches = new WeakMap<CanvasRenderingContext2D, {
  fonts: FontFaceSet | undefined; epoch: number; typography: string;
  layouts: Map<string, SpeechTextLayout>; widths: Map<string, number>;
}>();

function fontEpoch(fonts: FontFaceSet | undefined) {
  if (!fonts) return 0;
  let epoch = fontEpochs.get(fonts);
  if (!epoch) {
    epoch = { value: 0 };
    fontEpochs.set(fonts, epoch);
    const current = epoch;
    // Listeners retain only the shared revision, never a canvas or its cache.
    const invalidate = () => { current.value++; };
    fonts.addEventListener?.("loading", invalidate);
    fonts.addEventListener?.("loadingdone", invalidate);
    fonts.addEventListener?.("loadingerror", invalidate);
  }
  return epoch.value;
}

function remember<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): V {
  if (cache.size >= limit) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

function measuredText(text: string, width: number, measure: (text: string) => number): SpeechTextLayout {
  const wrapped = wrap(text, width, measure);
  return { ...wrapped, widths: wrapped.lines.map(measure) };
}

function textLayoutReader(ctx: CanvasRenderingContext2D): SpeechTextLayoutReader {
  const canvas = ctx.canvas;
  const document = canvas?.ownerDocument ?? globalThis.document;
  const fonts = document?.fonts, epoch = fontEpoch(fonts);
  const typography = JSON.stringify([ctx.font, ctx.fontKerning, ctx.fontStretch, ctx.fontVariantCaps,
    ctx.letterSpacing, ctx.wordSpacing, ctx.textRendering, ctx.direction, canvas?.lang, document?.documentElement?.lang]);
  let cache = textCaches.get(ctx);
  if (!cache || cache.fonts !== fonts || cache.epoch !== epoch || cache.typography !== typography) {
    cache = { fonts, epoch, typography, layouts: new Map(), widths: new Map() };
    textCaches.set(ctx, cache);
  }
  // Do not preserve fallback metrics while any document face is still loading.
  if (fonts?.status === "loading") {
    cache.layouts.clear(); cache.widths.clear();
    return (text, width) => measuredText(text, width, value => ctx.measureText(value).width);
  }
  const { layouts, widths } = cache;
  const measure = (text: string) => widths.get(text)
    ?? remember(widths, text, ctx.measureText(text).width, TEXT_MEASURE_LIMIT);
  return (text, width) => {
    const key = JSON.stringify([text, width]);
    return layouts.get(key) ?? remember(layouts, key, measuredText(text, width, measure), TEXT_LAYOUT_LIMIT);
  };
}

function wrap(text: string, width: number, measure: (text: string) => number): { lines: string[]; truncated: boolean } {
  const words = text.replace(/\s+/gu, " ").trim().slice(0, 280).split(" ");
  if (words.length === 1 && !words[0]) return { lines: [], truncated: false };
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
  const truncated = lines.length > MAX_LINES;
  if (truncated) {
    lines.length = MAX_LINES;
    let last = Array.from(lines[MAX_LINES - 1]);
    while (last.length && measure(`${last.join("").trimEnd()}…`) > width) last = last.slice(0, -1);
    lines[MAX_LINES - 1] = `${last.join("").trimEnd()}…`;
  }
  return { lines, truncated };
}

/** Pure layout; never moves a resident, advances speech or mutates its frame. */
export function layoutForestSpeech(frame: ForestSpeechCanvasFrame, viewport: ForestSpeechViewport,
  measure: (text: string) => number): ForestSpeechLayout | null {
  return layoutSpeech(frame, viewport, (text, width) => measuredText(text, width, measure));
}

function layoutSpeech(frame: ForestSpeechCanvasFrame, viewport: ForestSpeechViewport,
  readText: SpeechTextLayoutReader): ForestSpeechLayout | null {
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
  const contentWidth = Math.min(154, available - PADDING * 2);
  let { lines, widths } = readText(frame.text, contentWidth);
  if (!lines.length) return null;
  const rightX = anchor.x + 9;
  const rightWidth = Math.min(174, right - rightX);
  // A narrow, complete two-line reply keeps the bubble beside the head even
  // inside the circular view. Never trade away words just to force this side.
  if (rightWidth >= 92 && widths.some(width => width + PADDING * 2 > rightWidth)) {
    const compact = readText(frame.text, rightWidth - PADDING * 2);
    if (!compact.truncated) { lines = compact.lines; widths = compact.widths; }
  }
  const boxWidth = Math.min(available, Math.max(88,
    ...widths.map(width => width + PADDING * 2)));
  const boxHeight = VERTICAL_PADDING * 2 + LABEL_HEIGHT + lines.length * LINE_HEIGHT - 3;
  if (boxHeight > bottom - top) return null;
  const entrance = clamp(elapsed / .24, 0, 1);
  const eased = 1 - (1 - entrance) ** 3;
  const opacity = viewport.reducedMotion ? 1 : Math.min(eased, clamp((duration - elapsed) / .32, 0, 1));
  const rise = viewport.reducedMotion ? 0 : (1 - eased) * 4;
  const side = anchor.y - 14 - boxHeight >= top || anchor.y - top >= bottom - anchor.y ? "bottom" : "top";
  // Keep the body beside the face. A full left placement is preferable to covering
  // the speaker when there is no room on the right; narrow circles use the clamp.
  const leftX = anchor.x - 9 - boxWidth;
  const preferredX = rightX + boxWidth > right && leftX >= left ? leftX : rightX;
  const x = clamp(preferredX, left, right - boxWidth);
  const y = clamp(side === "bottom" ? anchor.y - 14 - boxHeight + rise : anchor.y + 14 - rise, top, bottom - boxHeight);
  const tailX = clamp(anchor.x, x + 17, x + boxWidth - 17);
  return { id: frame.id, speaker: frame.speaker, label: LABELS[frame.speaker], lines: lines.slice(),
    x, y, width: boxWidth, height: boxHeight, opacity,
    tail: { side, x: tailX, tipX: clamp(anchor.x, tailX - 28, tailX + 28),
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
    const readText = textLayoutReader(ctx);
    let box: ForestSpeechLayout | null = null;
    for (const frame of frames) {
      box = layoutSpeech(frame, viewport, readText);
      if (box) break;
    }
    if (!box || box.opacity <= 0) return box;
    ctx.globalAlpha = box.opacity;
    ctx.shadowColor = viewport.night ? "rgba(12, 19, 25, .28)" : "rgba(58, 45, 29, .16)";
    ctx.shadowBlur = 8; ctx.shadowOffsetY = 2; ctx.shadowOffsetX = 0;
    ctx.fillStyle = viewport.night ? "#efe8d8" : "#fff8e9";
    outline(ctx, box); ctx.fill();
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.strokeStyle = viewport.night ? "#b5a58b" : "#d1bea0"; ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.font = LABEL_FONT; ctx.fillStyle = INK[box.speaker];
    ctx.fillText(box.label, box.x + PADDING, box.y + VERTICAL_PADDING - 1, box.width - PADDING * 2);
    ctx.font = FOREST_SPEECH_FONT; ctx.fillStyle = "#453d30";
    box.lines.forEach((line, index) => ctx.fillText(line, box.x + PADDING,
      box.y + VERTICAL_PADDING + LABEL_HEIGHT + index * LINE_HEIGHT, box.width - PADDING * 2));
    return box;
  } finally { ctx.restore(); }
}
