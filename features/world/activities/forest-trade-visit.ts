import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import { canStartClearingLife, isClearingAtPoint, releaseClearingPoint, requestClearingPoint } from "@/features/world/simulation/clearing-activity";
import type { ForestDirectorOptions } from "@/features/world/simulation/forest-director";
import { beginForestIntention, finishForestIntention } from "@/features/world/simulation/forest-mind";
import type { ForestSessionState } from "@/features/world/state/forest-session";
import { findWorldPath } from "@/features/world/navigation/navigation";
import { requestPleskTrade } from "@/features/world/characters/plesk/plesk-mind";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";

export type ForestTradeVisit = {
  phase: "outbound" | "waiting" | "visiting" | "returning";
  target: WorldPoint; vendor: WorldPoint; home: WorldPoint; direction: PixelDirection;
  phaseElapsed: number;
};
const VISIT_SECONDS = 10, VENDOR_WAIT_SECONDS = 45, WALK_TIMEOUT_SECONDS = 120;
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const finite = (point: WorldPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);
function ownsPoint(state: ForestSessionState, visit: ForestTradeVisit) {
  const point = visit.phase === "returning" ? visit.home : visit.target;
  return Boolean(state.clearing.requestedPoint && distance(state.clearing.requestedPoint, point) < .001);
}

/** Presentation only: opening the shop and economic commands never wait for this visit. */
export function requestForestTradeVisit(state: ForestSessionState, scene: FixedWorldScene, options: ForestDirectorOptions): boolean {
  const { clearing, director, life } = state;
  const point = scene.destinations?.find(item => item.id === "plesk-customer" && item.siteId === "plesk-shop")?.position;
  const vendor = scene.destinations?.find(item => item.id === "plesk-trade")?.position;
  const shop = scene.sites.find(item => item.id === "plesk-shop");
  const freeRoam = clearing.stage === "free-walk" && clearing.freePurpose === "roam";
  if (!point || !finite(point) || !vendor || !finite(vendor) || !shop || !clearing.navigation || !clearing.navigationEnabled
    || options.reducedMotion || options.navigationMode === "routes" || options.blocked || options.actorAway || options.explicitTravel
    || state.explorationId || state.journeyTravel || state.cookingPreview || state.animation || state.reaction > 0
    || state.pendingLife || state.pendingAttention || director.activeKey || director.tradeVisit || director.birdwatch || director.campfireVisit
    || life.routine || life.garden.routine || life.garden.harvest || life.garden.basket?.held || state.fauna.encounter
    || clearing.requestedPoint || clearing.activeInteraction || clearing.retiring || clearing.bushRequested
    || clearing.pendingBush !== null || clearing.pendingInteractionBush !== null
    || !(canStartClearingLife(clearing) || freeRoam)) return false;
  // Validate both legs before taking ownership. A disconnected stall is still a usable shop.
  if (!findWorldPath(clearing.navigation, point, clearing.home) || !requestClearingPoint(clearing, point)) return false;
  const dx = vendor.x - point.x, dy = vendor.y - point.y;
  const direction: PixelDirection = Math.abs(dx) > Math.abs(dy) ? dx < 0 ? "left" : "right" : dy < 0 ? "back" : "front";
  director.tradeVisit = { phase: "outbound", target: { ...point }, vendor: { ...vendor }, home: { ...clearing.home }, direction, phaseElapsed: 0 };
  director.activeKey = "trade:plesk-shop";
  director.reason = "Идёт к прилавку Плёски";
  beginForestIntention(clearing.behavior.mind, "look", "trade:plesk-shop", director.reason, "director");
  return true;
}

export function cancelForestTradeVisit(state: ForestSessionState, reason = "Возвращается к своим делам") {
  const visit = state.director.tradeVisit;
  if (!visit) return;
  if (ownsPoint(state, visit)) releaseClearingPoint(state.clearing);
  state.director.tradeVisit = null;
  if (state.director.activeKey === "trade:plesk-shop") state.director.activeKey = null;
  if (state.clearing.behavior.mind.intention?.key === "trade:plesk-shop")
    finishForestIntention(state.clearing.behavior.mind, "interrupted", reason);
  state.director.nextDecisionAt = state.director.elapsed + 8;
}

export function advanceForestTradeVisit(state: ForestSessionState, dt: number, options: ForestDirectorOptions) {
  const visit = state.director.tradeVisit;
  if (!visit || !Number.isFinite(dt) || dt <= 0) return;
  if (options.reducedMotion || options.blocked || options.actorAway || options.explicitTravel
    || options.navigationMode === "routes" || !state.clearing.navigationEnabled
    || state.explorationId || state.journeyTravel || state.cookingPreview || !ownsPoint(state, visit)) {
    cancelForestTradeVisit(state); return;
  }
  visit.phaseElapsed += Math.min(dt, .1);
  if (visit.phase === "outbound" && isClearingAtPoint(state.clearing, visit.target)) {
    visit.phase = "waiting"; visit.phaseElapsed = 0;
    state.director.reason = "Осматривает прилавок, пока Плёска заканчивает свои дела";
    // The authored walk can outlast her first trading shift. Invite her once on
    // arrival; the resident still finishes her actual cast and deposit safely.
    requestPleskTrade(state.pleskMind);
  }
  if (visit.phase === "waiting" && state.pleskMind?.available && distance(state.pleskMind.position, visit.vendor) <= 8
    && ["idle", "greet", "trade"].includes(state.pleskMind.stage.action)) {
    visit.phase = "visiting"; visit.phaseElapsed = 0;
    state.director.reason = "Приветствует Плёску и осматривает прилавок";
  }
  if (visit.phase === "visiting" && visit.phaseElapsed >= VISIT_SECONDS
    || visit.phase === "waiting" && visit.phaseElapsed >= VENDOR_WAIT_SECONDS
    || visit.phase === "outbound" && visit.phaseElapsed >= WALK_TIMEOUT_SECONDS) {
    if (!requestClearingPoint(state.clearing, visit.home)) { cancelForestTradeVisit(state); return; }
    visit.phase = "returning"; visit.phaseElapsed = 0;
    state.director.reason = "Возвращается с прилавка на полянку";
  }
  if (visit.phase !== "returning") return;
  if (isClearingAtPoint(state.clearing, visit.home)) {
    finishForestIntention(state.clearing.behavior.mind, "completed", "Навестил прилавок Плёски и вернулся на полянку");
    state.director.tradeVisit = null;
    // The director records completion and releases only this reserved point.
  } else if (visit.phaseElapsed >= WALK_TIMEOUT_SECONDS) cancelForestTradeVisit(state);
}

/** A short greeting followed by idle looking; feet remain owned by clearing navigation. */
export function forestTradeVisitFrame(state: ForestSessionState): { pose: PixelPose; direction: PixelDirection; frame: number } | null {
  const visit = state.director.tradeVisit;
  if (!visit || !["waiting", "visiting"].includes(visit.phase) || !isClearingAtPoint(state.clearing, visit.target)) return null;
  return { pose: visit.phase === "visiting" && visit.phaseElapsed < 1.5 ? "greet" : "idle", direction: visit.direction, frame: Math.floor(visit.phaseElapsed * 4) % 4 };
}
