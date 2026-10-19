"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle, RefreshCw, WifiOff } from "lucide-react";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { FriendWorldMarket } from "@/features/economy/ui/market/friend-world-market";
import { FriendWorldView } from "@/features/world/ui/visits/friend-world-view";
import type { GuestWorldTarget } from "./guest-world-model";
import { useMarketAudio } from "@/features/world/audio/use-market-audio";
import { useGuestWorld } from "./use-guest-world";
import styles from "./guest-world-visit.module.css";

export type GuestWorldVisitProps = {
  ownerPublicId: string; target: GuestWorldTarget; economy: EconomyController;
  isOnline?: boolean; onSessionLost?: () => void; suspended?: boolean; timeZone: string;
  onReturn: () => void; onSceneReady?: () => void;
};

function VisitStatus({ text, loading = false, offline = false, onReturn, onRetry }: {
  text: string; loading?: boolean; offline?: boolean; onReturn: () => void; onRetry?: () => void;
}) {
  return <div className={styles.status} data-guest-world-status>
    <div className={styles.card}>
      {loading ? <LoaderCircle className={styles.spinner} size={30} aria-hidden="true" /> : offline ? <WifiOff size={30} aria-hidden="true" /> : null}
      <p role="status">{text}</p>
      <div className={styles.actions}>
        <button type="button" data-guest-return onClick={onReturn}><ArrowLeft size={17} aria-hidden="true" />В свой лес</button>
        {onRetry && <button type="button" onClick={onRetry}><RefreshCw size={17} aria-hidden="true" />Попробовать ещё раз</button>}
      </div>
    </div>
  </div>;
}

function LoadedGuestWorld({ ownerPublicId, target, economy, onSessionLost, timeZone, onReturn, onSceneReady }: GuestWorldVisitProps) {
  const visit = useGuestWorld(ownerPublicId, target, onSessionLost);
  const refreshGuest = visit.refresh;
  const [shopOpen, setShopOpen] = useState(false);
  useMarketAudio({ active: shopOpen && Boolean(visit.data), ownerPublicId: target.targetPublicId, now: visit.now, timeZone, readOnly: true });
  const root = useRef<HTMLDivElement>(null);
  const shopReturn = useRef<HTMLElement | null>(null);
  const focusedScene = useRef(false);
  const revision = useRef(economy.snapshot?.revision ?? null);
  useEffect(() => {
    if (economy.busy || economy.uncertain || economy.snapshot?.ownerPublicId !== ownerPublicId) return;
    const next = economy.snapshot.revision;
    if (revision.current !== null && next > revision.current) refreshGuest();
    revision.current = next;
  }, [economy.busy, economy.uncertain, economy.snapshot, ownerPublicId, refreshGuest]);
  const hasData = Boolean(visit.data);
  useEffect(() => {
    // Only the first real scene steals focus from the loading screen, never a poll or purchase.
    if (hasData && !focusedScene.current) {
      focusedScene.current = true;
      root.current?.querySelector<HTMLElement>("#friend-world-return")?.focus({ preventScroll: true });
    } else if (!hasData) {
      focusedScene.current = false;
      root.current?.querySelector<HTMLElement>("[data-guest-return]")?.focus({ preventScroll: true });
    }
  }, [hasData]);

  return <div ref={root} className={styles.visit}>
    {visit.data ? <>
      <FriendWorldView visit={visit.data} now={visit.now} timeZone={timeZone} onReturn={onReturn}
        onReady={onSceneReady} suspended={shopOpen} onRefresh={visit.refresh} refreshing={visit.refreshing}
        onOpenShop={() => {
          shopReturn.current = document.activeElement instanceof HTMLElement && root.current?.contains(document.activeElement)
            ? document.activeElement : null;
          setShopOpen(true); visit.refresh();
        }} />
      <FriendWorldMarket open={shopOpen} visit={visit.data} economy={economy} onRefresh={visit.refresh}
        refreshing={visit.refreshing} onClose={() => setShopOpen(false)} onReturnFocus={() => {
          const trigger = shopReturn.current;
          if (trigger?.isConnected) trigger.focus({ preventScroll: true });
          else root.current?.querySelector<HTMLElement>("#friend-world-return, [data-guest-return]")?.focus({ preventScroll: true });
        }} />
    </> : <VisitStatus text={visit.loading ? `Идём в гости к ${target.displayName}…` : visit.error ?? "Мир друга недоступен."}
      loading={visit.loading} onReturn={onReturn} onRetry={!visit.loading ? visit.refresh : undefined} />}
  </div>;
}

/** Account/subject switches and offline suspension destroy the previous live scene. */
export function GuestWorldVisit(props: GuestWorldVisitProps) {
  if (props.isOnline === false) return <VisitStatus text="Нужен интернет, чтобы прийти в гости."
    offline onReturn={props.onReturn} />;
  if (props.suspended) return <VisitStatus text="Визит приостановлен. Вернитесь в игру, чтобы продолжить." onReturn={props.onReturn} />;
  return <LoadedGuestWorld key={`${props.ownerPublicId}:${props.target.circleId}:${props.target.targetPublicId}`} {...props} />;
}
