import { feedingFrame } from "./feeding";
import type { HabitatState } from "./habitat";
import type { PixelDirection, PixelPose } from "./pixel-sprite";

const ease = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

/** A single sprite and a continuous foliage envelope for every phase of bush play. */
export function pixelFrame(state: HabitatState, reducedMotion = false) {
  const a = state.activity, p = state.progress, t = reducedMotion ? 0 : state.activityTime;
  const walking = ["walk", "approach", "enter", "leave", "chase", "carry"].includes(a);
  const airborne = a === "jump" || a === "emerge" || a === "pounce";
  let pose: PixelPose = walking ? "walk" : "idle";
  if (a === "sleep") pose = state.wakeTaps > 1 ? "drowsy" : "sleep";
  else if (a === "stir") pose = state.wakeTaps > 1 ? "drowsy" : "sleep";
  else if (a === "wake") pose = p < .3 ? "sleep" : p < .55 ? "blink" : "stretch";
  else if (a === "balance") pose = state.insectKind === "firefly" ? "hold" : "greet";
  else if (a === "watch") pose = "crouch";
  else if (a === "release") pose = "stretch";
  else if (["scratch", "yawn", "shake", "sneeze", "wonder", "carry"].includes(a)) pose = a as PixelPose;
  else if (a === "pickup") pose = p < .35 ? "reach" : "hold";
  else if (a === "place" || a === "catch") pose = "hold";
  else if (a === "toss") pose = "toss";
  else if (a === "show") pose = "present";
  else if (a === "discover" || a === "rain-notice" || a === "leaf-drift") pose = "wonder";
  else if (a === "shelter") pose = "crouch";
  else if (a === "shelter-peek") pose = "sniff";
  else if (a === "crouch") pose = "crouch";
  else if (airborne) pose = p < .15 || p > .85 ? "crouch" : "jump";
  else if (a === "eat") {
    const phase = feedingFrame(p).phase;
    pose = phase === "lift" ? "hold" : phase;
  }
  else if (a === "groom" || a === "greet" || a === "sniff") pose = a;
  else if (!walking && t % 4.7 > 4.45) pose = "blink";
  let sink = 0, opacity = 1;
  if (a === "hide") opacity = 0;
  else if (a === "jump") { opacity = 1 - ease((p - .65) / .35); }
  else if (a === "peek") {
    const reveal = Math.sin(Math.PI * p) ** 2;
    sink = -.045 * reveal; opacity = ease(reveal / .35);
  } else if (a === "emerge") { opacity = ease(p / .35); }
  const direction: PixelDirection = walking || airborne || a === "crouch" ? state.direction : "front";
  // Distance-driven footsteps stay in contact with the ground as movement eases in/out.
  let frame = reducedMotion ? 0 : Math.floor(walking ? state.distance * 160 : t * (a === "eat" ? 5 : 2)) % 4;
  if (a === "balance" && state.insectKind === "firefly") frame = 3;
  if (["yawn", "sneeze", "toss"].includes(a)) frame = Math.min(3, Math.floor(p * 4));
  if (a === "sneeze" && p < .25) pose = "sniff";
  if (a === "pickup") frame = p < .35 ? Math.min(3, Math.floor(p / .35 * 4)) : Math.min(3, Math.floor((p - .35) / .65 * 4));
  if (a === "catch") frame = 3;
  if (a === "place") frame = 3 - Math.min(3, Math.floor(p * 4));
  if (!reducedMotion && (a === "scratch" || a === "shake")) frame = Math.floor(t * (a === "shake" ? 12 : 6)) % 4;
  if (!reducedMotion && a === "eat") {
    if (pose === "reach") frame = Math.min(3, Math.floor(p / .22 * 4));
    if (pose === "hold") frame = Math.min(3, Math.floor((p - .22) / .20 * 4));
  }
  const offsetX = reducedMotion ? 0 : a === "shake" ? Math.sin(t * 34) * .007 * Math.sin(Math.PI * p)
    : a === "shelter-peek" ? Math.sin(Math.PI * p) * .025 : 0;
  const offsetY = reducedMotion ? 0 : a === "sneeze" ? Math.sin(Math.PI * p) ** 4 * .012 : 0;
  return { pose, direction, frame, sink, opacity, offsetX, offsetY };
}
