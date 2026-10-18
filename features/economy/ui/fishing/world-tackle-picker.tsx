"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { ArrowRight, Check, ChevronRight, Fish, X } from "lucide-react";
import type { EconomyView } from "@/features/economy/domain/model";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { fishingBaitCompatible, fishingClassOdds, fishingState } from "@/features/economy/domain/fishing";
import { locked } from "@/features/economy/sync/controller-state";
import { ItemIcon } from "@/features/items/item-icon";
import { FishingRodIcon } from "@/features/world/activities/fishing/fishing-rod-icon";
import { itemName, number } from "@/features/economy/ui/shared/world-economy-parts";
import { FISH_RARITY_NAMES, type FishRarity } from "./fish-rarity";
import styles from "./world-tackle-picker.module.css";

export type TackleKind = "rod" | "hook" | "bait";
type Override = Parameters<typeof fishingClassOdds>[2];
export type TackleOption = { id: string; name: string; rarity: FishRarity | null; direction: string; selected: boolean; available: boolean;
  stock?: number; override: Override; removesBait?: boolean; targets?: FishRarity[] };
type Quote = { kind: TackleKind; owner: string; revision: number };
type Props = { state: EconomyView; economy: EconomyController; disabled: boolean;
  /** Shares the preparation's synchronous latch with departure. */
  onChoose: (kind: TackleKind, itemId: string) => boolean; onOpenFishingShop?: () => void };
const labels: Record<TackleKind, string> = { rod: "Удочка", hook: "Крючок", bait: "Наживка" };
const headings: Record<TackleKind, string> = { rod: "Выберите удочку", hook: "Выберите крючок", bait: "Выберите наживку" };
const fishTargets: Record<FishRarity, string> = { common: "обычной", uncommon: "необычной", rare: "редкой", epic: "эпической", legendary: "легендарной" };
const percentages = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const percent = (probability: number) => `${percentages.format(probability * 100)}%`;
const boostedTargets = (weights?: Partial<Record<FishRarity, number>> | null) =>
  (Object.keys(fishTargets) as FishRarity[]).filter(rarity => (weights?.[rarity] ?? 100) > 100);
const direction = (targets: FishRarity[], bonus = false) => `${bonus ? "Бонус для" : "Для"} ${targets.map(rarity => fishTargets[rarity]).join(" и ")} рыбы`;

/** Gear previews include the server's automatic removal of incompatible bait. */
export function fishingTackleOptions(state: EconomyView, kind: TackleKind): TackleOption[] {
  const catalog = state.catalog.fishing, gear = fishingState(state);
  if (!catalog) return [];
  if (kind === "rod") return catalog.rods.filter(rod => gear.ownedRods.includes(rod.id)).map(rod => {
    const removesBait = Boolean(gear.equippedBaitId && !fishingBaitCompatible(rod.id, gear.equippedBaitId, catalog));
    const targets = rod.shop === "leaftail" && rod.classOddsBps
      ? (Object.keys(fishTargets) as FishRarity[]).filter(rarity => rod.classOddsBps![rarity] > 0)
        .sort((a, b) => rod.classOddsBps![b] - rod.classOddsBps![a]).slice(0, 2) : [rod.rarity];
    return { id: rod.id, name: rod.name, rarity: rod.rarity, targets, direction: direction(targets), selected: rod.id === gear.equippedRodId,
      available: true, override: { rodId: rod.id, ...(removesBait ? { baitId: null } : {}) }, removesBait };
  });
  if (kind === "hook") return catalog.hooks.filter(hook => gear.ownedHooks.includes(hook.id)).map(hook => {
    const targets = boostedTargets(hook.rarityWeights);
    return { id: hook.id, name: hook.name, targets: targets.length ? targets : undefined,
      rarity: hook.id === "bare_hook" ? null : hook.rarity, direction: hook.id === "bare_hook" ? "Базовые шансы удочки" : direction(targets.length ? targets : [hook.rarity], true),
      selected: hook.id === gear.equippedHookId, available: true, override: { hookId: hook.id } };
  });
  return [{ id: "none", name: "Без наживки", rarity: null, direction: "Без расхода припасов", selected: gear.equippedBaitId === null,
    available: true, override: { baitId: null } }, ...catalog.baits.filter(bait => (state.inventory[bait.itemId] ?? 0) > 0).map(bait => {
    const targets = boostedTargets(bait.rarityWeights);
    return { id: bait.itemId, name: itemName(state, bait.itemId), rarity: bait.rarity, targets: targets.length ? targets : undefined,
      direction: direction(targets.length ? targets : [bait.rarity], true),
      selected: bait.itemId === gear.equippedBaitId, available: fishingBaitCompatible(gear.equippedRodId, bait.itemId, catalog),
      stock: state.inventory[bait.itemId], override: { baitId: bait.itemId },
    };
  })];
}

/** Unknown, unowned or depleted gear never reaches an equipment command. */
export function fishingTackleChoice(state: EconomyView, kind: TackleKind, itemId: string) {
  return fishingTackleOptions(state, kind).find(option => option.id === itemId && option.available && !option.selected);
}

function TackleArt({ kind, itemId, size }: { kind: TackleKind; itemId: string; size: number }) {
  return kind === "rod" ? <FishingRodIcon rodId={itemId} size={size} /> : itemId === "none" ? <Fish size={size} aria-hidden="true" /> : <ItemIcon itemId={itemId} size={size} />;
}

function TargetOdds({ state, option }: { state: EconomyView; option: TackleOption }) {
  const catalog = state.catalog.fishing!;
  const before = fishingClassOdds(state, catalog), after = fishingClassOdds(state, catalog, option.override);
  const fallback = option.rarity ?? after.reduce((best, odd) => Math.abs(odd.probability - (before.find(current => current.rarity === odd.rarity)?.probability ?? 0))
    > Math.abs(best.probability - (before.find(current => current.rarity === best.rarity)?.probability ?? 0)) ? odd : best, after[0]).rarity;
  return <>{(option.targets?.length ? option.targets : [fallback]).map(target => {
    const current = before.find(odd => odd.rarity === target)!.probability, preview = after.find(odd => odd.rarity === target)!.probability;
    const changed = Math.abs(current - preview) > 1e-10;
    return <span key={target} className={styles.optionOdds} data-tackle-odds={target} data-change={changed ? preview > current ? "increase" : "decrease" : undefined}
      aria-label={`${FISH_RARITY_NAMES[target]} рыба: ${changed ? `${percent(current)} → ${percent(preview)}` : percent(preview)}`}>
      <span>{FISH_RARITY_NAMES[target]}</span>{changed && <><s>{percent(current)}</s><ArrowRight size={11} aria-hidden="true" /></>}<strong>{percent(preview)}</strong>
    </span>;
  })}</>;
}

/** Opening previews owned gear; one explicit item tap equips it for future trips. */
export function WorldTacklePicker(props: Props) {
  const { state, economy, disabled, onOpenFishingShop } = props;
  const [quote, setQuote] = useState<Quote | null>(null), [error, setError] = useState<string | null>(null);
  const latest = useRef({ props, quote }), sent = useRef<Quote | null>(null), navigating = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null), headingId = useId();
  useLayoutEffect(() => { latest.current = { props, quote }; }, [props, quote]);
  const catalog = state.catalog.fishing, gear = fishingState(state);
  if (!catalog) return null;
  const quoteCurrent = Boolean(quote && quote.owner === state.ownerPublicId && quote.revision === state.revision
    && economy.snapshot?.ownerPublicId === quote.owner && economy.snapshot?.revision === quote.revision);
  const options = quote ? fishingTackleOptions(state, quote.kind) : [];
  function choose(itemId: string) {
    const current = latest.current, snapshot = current.props.economy.snapshot;
    if (!quote || current.quote !== quote || sent.current === quote || current.props.disabled || locked(current.props.economy)
      || !snapshot || snapshot.ownerPublicId !== quote.owner || snapshot.revision !== quote.revision
      || current.props.state.ownerPublicId !== quote.owner || current.props.state.revision !== quote.revision) return;
    const option = fishingTackleOptions(snapshot, quote.kind).find(entry => entry.id === itemId && entry.available);
    if (!option) return;
    if (option.selected) { setQuote(null); return; }
    sent.current = quote;
    if (current.props.onChoose(quote.kind, itemId)) { setQuote(null); setError(null); }
    else { sent.current = null; setError("Снасть не выбрана. Попробуйте ещё раз."); }
  }
  return <section className={styles.gear} aria-label="Снасти для вылазки" data-fishing-tackle>
    <div className={styles.heading}><strong>Снасти</strong><small>Нажмите, чтобы сменить</small></div>
    <div className={styles.slots}>{(["rod", "hook", "bait"] as const).map(kind => {
      const currentId = kind === "rod" ? gear.equippedRodId : kind === "hook" ? gear.equippedHookId : gear.equippedBaitId ?? "none";
      const current = fishingTackleOptions(state, kind).find(option => option.id === currentId);
      const absentBait = kind === "bait" && gear.equippedBaitId && !current;
      const name = current?.name ?? (absentBait ? itemName(state, currentId) : headings[kind]);
      const direction = current && !current.available ? "Не подходит к удочке" : current?.direction ?? (absentBait ? "Нет в запасе" : "Выберите из своих снастей");
      const open = quoteCurrent && quote?.kind === kind;
      return <Popover.Root key={kind} open={open} onOpenChange={value => {
        if (!value) setQuote(null);
        else {
          const current = latest.current.props;
          if (current.disabled || locked(current.economy) || current.economy.snapshot?.ownerPublicId !== current.state.ownerPublicId
            || current.economy.snapshot?.revision !== current.state.revision) return;
          navigating.current = false; sent.current = null; setError(null);
          setQuote({ kind, owner: current.state.ownerPublicId, revision: current.state.revision });
        }
      }}><Popover.Trigger asChild><button type="button" className={styles.slot} data-tackle-slot={kind} data-tackle-equipped={currentId}
        disabled={disabled || (kind !== "bait" && fishingTackleOptions(state, kind).length === 0)} aria-label={`${labels[kind]}: ${name}. Изменить`}>
        <span className={styles.slotArt}><TackleArt kind={kind} itemId={currentId} size={kind === "rod" ? 32 : 25} /></span>
        <span className={styles.slotText}><small>{labels[kind]}</small><strong>{name}</strong><span>{direction}</span>
          {kind === "bait" && currentId !== "none" && <span>{current?.stock ? `В запасе ${number(current.stock)} · за поход 1` : "За поход 1"}</span>}
        </span><ChevronRight size={14} aria-hidden="true" />
      </button></Popover.Trigger>
      {open && quote && <Popover.Portal><Popover.Content className={styles.picker} data-tackle-picker={kind} side="top" align="center" sideOffset={7} collisionPadding={12}
        aria-labelledby={headingId} onOpenAutoFocus={event => { event.preventDefault(); heading.current?.focus({ preventScroll: true }); }}
        onEscapeKeyDown={event => event.stopPropagation()} onCloseAutoFocus={event => { if (navigating.current) event.preventDefault(); }}
        onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
        <header className={styles.pickerHeading}><div><h3 ref={heading} tabIndex={-1} id={headingId}>{headings[kind]}</h3><p>Нажмите на снасть, чтобы выбрать</p></div>
          <Popover.Close asChild><button type="button" data-tackle-picker-close aria-label="Закрыть выбор снастей"><X size={17} aria-hidden="true" /></button></Popover.Close>
        </header>
        {error && <p className={styles.note} role="status">{error}</p>}
        <div className={styles.options} aria-label={headings[kind]}>{options.map(option => <button type="button" key={option.id} className={styles.option}
          data-tackle-option={option.id} data-selected={option.selected || undefined} disabled={disabled || !option.available}
          aria-label={`${option.name}. ${option.direction}${!option.available ? ". Не подходит к удочке" : ""}`} aria-pressed={option.selected} onClick={() => choose(option.id)}>
          <span className={styles.optionArt}><TackleArt kind={kind} itemId={option.id} size={kind === "rod" ? 40 : 29} /></span>
          <span className={styles.optionText}><strong>{option.name}</strong><span>{option.direction}</span>
            {option.available ? <TargetOdds state={state} option={option} /> : <small>Не подходит к этой удочке</small>}
            {option.stock !== undefined && <small>В запасе {number(option.stock)} · за поход 1</small>}
            {option.removesBait && <small>Наживка останется в кладовой</small>}
          </span>{option.selected ? <Check size={17} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
        </button>)}</div>
        <p className={styles.note}>{kind === "bait" ? "Выбор не тратит наживку. Одна порция уйдёт при отправлении." : "Удочка и крючок не расходуются."}</p>
      </Popover.Content></Popover.Portal>}
      </Popover.Root>;
    })}</div>
    {onOpenFishingShop && <button type="button" className={styles.shop} onClick={() => { navigating.current = true; setQuote(null); onOpenFishingShop(); }}>Купить снасти у Плёски<ArrowRight size={12} aria-hidden="true" /></button>}
  </section>;
}
