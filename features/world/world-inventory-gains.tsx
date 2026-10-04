"use client";

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { PackageCheck } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import type { EconomyController } from "@/features/economy/use-economy";
import type { InventoryGain } from "@/features/economy/inventory-gain";
import { createInventoryGainPlayback } from "./inventory-gain-playback";
import styles from "./world-inventory-gains.module.css";

const NO_GAINS: readonly InventoryGain[] = [];
const VISIBLE_ITEMS = 3;
const subscribeClient = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function InventoryGainContents({ event, names }: { event: InventoryGain; names: Readonly<Record<string, string>> }) {
  const itemName = (itemId: string) => names[itemId] ?? itemId;
  return <>
    <span className={styles.heading}><PackageCheck size={14} aria-hidden="true" />В кладовую</span>
    <div className={styles.items}>
      {event.items.slice(0, VISIBLE_ITEMS).map((item, index) => <span key={item.itemId} className={styles.item}
        data-inventory-item={item.itemId} data-quantity={item.quantity} style={{ "--gain-delay": `${index * 75}ms` } as CSSProperties}>
        <span className={styles.icon}><ItemIcon itemId={item.itemId} size={27} /></span>
        <span className={styles.name}>{itemName(item.itemId)}</span><strong>+{item.quantity.toLocaleString("ru-RU")}</strong>
      </span>)}
    </div>
    {event.items.length > VISIBLE_ITEMS && <span className={styles.more}>Ещё предметов: {event.items.length - VISIBLE_ITEMS}
      <span className={styles.sr}>. {event.items.slice(VISIBLE_ITEMS).map(item => `${itemName(item.itemId)} +${item.quantity}`).join(", ")}</span>
    </span>}
    <span className={styles.glints} aria-hidden="true"><i /><i /><i /></span>
  </>;
}

/** Mount once inside the existing upper HUD and key by account. Fixed overlay
 * geometry adds no lower UI and receives only accepted local receipt events. */
export function WorldInventoryGains({ economy, ready = true, hud }: {
  economy: EconomyController; ready?: boolean; hud?: RefObject<HTMLElement | null>;
}) {
  const gains = economy.inventoryGains ?? NO_GAINS, owner = economy.snapshot?.ownerPublicId ?? null;
  const client = useSyncExternalStore(subscribeClient, clientSnapshot, serverSnapshot);
  const layer = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const player = useRef<ReturnType<typeof createInventoryGainPlayback> | null>(null);
  useLayoutEffect(() => {
    if (!client) return;
    if (player.current === null) {
      player.current = createInventoryGainPlayback(owner, gains, {
        show(event) {
          const element = elements.current.get(event.id);
          if (!element || document.hidden) return false;
          element.hidden = false; return true;
        },
        hide(event) { const element = elements.current.get(event.id); if (element) element.hidden = true; },
        schedule: (finish, milliseconds) => setTimeout(finish, milliseconds),
        cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
      });
    }
    player.current.receive(owner, gains, ready && !document.hidden);
  }, [owner, gains, ready, client]);
  useLayoutEffect(() => {
    if (!client || !hud?.current) return;
    const header = hud.current;
    const measure = () => {
      const element = layer.current;
      if (!element) return;
      const bounds = header.getBoundingClientRect();
      element.style.top = `${Math.max(8, Math.min(bounds.bottom + 7, window.innerHeight - 170))}px`;
      element.style.left = `${Math.max(12, Math.min(bounds.left + 12, window.innerWidth - 252))}px`;
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(header);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [client, hud]);
  useEffect(() => {
    const playback = player.current;
    const visibility = () => { if (document.hidden) playback?.clear(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("visibilitychange", visibility); playback?.clear(); };
  }, [client]);
  if (!client) return null;
  const names = Object.fromEntries((economy.snapshot?.catalog.items ?? []).map(item => [item.id, item.name]));
  return createPortal(<div ref={layer} className={styles.layer} aria-live="polite" aria-atomic="false" data-inventory-gains>
    {gains.filter(event => event.ownerPublicId === owner).map(event => <div key={event.id}
      ref={element => { if (element) elements.current.set(event.id, element); else elements.current.delete(event.id); }}
      hidden className={styles.effect} data-inventory-gain={event.id} data-inventory-owner={event.ownerPublicId} aria-atomic="true">
      <InventoryGainContents event={event} names={names} />
    </div>)}
  </div>, document.body);
}
