"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { Check, Minus, RotateCcw, WandSparkles, X } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { fishClassForItem } from "@/features/economy/domain/fishing";
import { autoFillFishSelection, fishSelectionMatches, fishStockEntries, fishStockRequirements, type FishSelection } from "@/features/economy/domain/fish-stock";
import { locked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import { itemName, number } from "@/features/economy/ui/shared/world-economy-parts";
import styles from "./world-fish-selection.module.css";

export type WorldFishSelectionProps = {
  economy: ReadyEconomy;
  requiredItems: Record<string, number>;
  contextId: string;
  confirmLabel: "Готовить" | "Отдать заказ";
  onConfirm: (selection: FishSelection) => boolean;
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
};
type Choice = { owner: string; revision: number; context: string; requirements: string; selection: FishSelection };

/** The picker owns an explicit debit choice; looking at a fish never spends it. */
export function WorldFishSelection(props: WorldFishSelectionProps) {
  const { economy, requiredItems, contextId, confirmLabel, onClose } = props;
  const state = economy.snapshot, requirements = JSON.stringify(Object.entries(requiredItems).sort());
  const freshChoice = (): Choice => ({ owner: state.ownerPublicId, revision: state.revision, context: contextId, requirements,
    selection: autoFillFishSelection(state, requiredItems) });
  const [choice, setChoice] = useState<Choice>(freshChoice);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const latest = useRef({ props, choice }), sent = useRef<Choice | null>(null);
  const titleId = useId(), descriptionId = useId();
  useLayoutEffect(() => { latest.current = { props, choice }; }, [props, choice]);
  if (choice.owner !== state.ownerPublicId || choice.revision !== state.revision || choice.context !== contextId || choice.requirements !== requirements) {
    setChoice(freshChoice());
    setNotice("Запасы изменились. Выбор обновлён, проверьте рыбу ещё раз.");
    setSubmitting(false);
  }
  const required = fishStockRequirements(requiredItems, state.catalog.fishing);
  const selectedTotal = (classId: string, selection = choice.selection) => Object.entries(selection)
    .filter(([id]) => fishClassForItem(id, state.catalog.fishing)?.itemId === classId).reduce((total, [, amount]) => total + amount, 0);
  function currentChoice() {
    const current = latest.current, snapshot = current.props.economy.snapshot;
    return current.choice === choice && sent.current !== choice && !locked(current.props.economy)
      && snapshot.ownerPublicId === choice.owner && snapshot.revision === choice.revision
      && current.props.contextId === choice.context && JSON.stringify(Object.entries(current.props.requiredItems).sort()) === choice.requirements
      ? current : null;
  }
  function change(itemId: string, classId: string, delta: 1 | -1) {
    const current = currentChoice();
    if (!current) return;
    const owned = fishStockEntries(current.props.economy.snapshot, classId).find(entry => entry.itemId === itemId)?.quantity ?? 0;
    setChoice(previous => {
      const selection = { ...previous.selection }, count = selection[itemId] ?? 0;
      if (delta < 0) { if (count <= 1) delete selection[itemId]; else selection[itemId] = count - 1; }
      else {
        if (count >= owned) return previous;
        if (selectedTotal(classId, selection) >= required[classId]) {
          const other = Object.entries(selection).find(([id, amount]) => id !== itemId && amount > 0 && fishClassForItem(id, state.catalog.fishing)?.itemId === classId);
          if (!other) return previous;
          if (other[1] === 1) delete selection[other[0]]; else selection[other[0]] = other[1] - 1;
        }
        selection[itemId] = count + 1;
      }
      return { ...previous, selection };
    });
    setNotice(null);
  }
  const valid = fishSelectionMatches(state, requiredItems, choice.selection);
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Portal><Dialog.Overlay className={styles.overlay} />
      <Dialog.Content className={styles.picker} aria-labelledby={titleId} aria-describedby={descriptionId} data-fish-selection={contextId}
        onCloseAutoFocus={props.onCloseAutoFocus} onEscapeKeyDown={event => event.stopPropagation()}
        onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
        <header className={styles.header}><Dialog.Title id={titleId}>Выберите рыбу</Dialog.Title><Dialog.Close asChild><button type="button" aria-label="Закрыть выбор рыбы"><X size={18} aria-hidden="true" /></button></Dialog.Close></header>
        <Dialog.Description id={descriptionId} className={styles.description}>Подойдёт любой вид нужной редкости. Нажмите на рыбу, чтобы добавить или заменить её.</Dialog.Description>
        <div className={styles.tools}><button type="button" data-fish-autofill disabled={locked(economy) || submitting} onClick={() => {
          const current = currentChoice(); if (!current) return;
          setChoice(previous => ({ ...previous, selection: autoFillFishSelection(current.props.economy.snapshot, current.props.requiredItems) })); setNotice(null);
        }}><WandSparkles size={15} aria-hidden="true" />Автозаполнение</button><button type="button" data-fish-clear disabled={locked(economy) || submitting} onClick={() => {
          if (currentChoice()) { setChoice(previous => ({ ...previous, selection: {} })); setNotice(null); }
        }}><RotateCcw size={14} aria-hidden="true" />Сбросить</button></div>
        <div className={styles.groups}>{Object.entries(required).map(([classId, amount]) => {
          const total = selectedTotal(classId), entries = fishStockEntries(state, classId);
          return <section key={classId} className={styles.group} data-fish-required-class={classId}>
            <h3><span>{itemName(state, classId)}</span><strong data-complete={total === amount || undefined}>{number(total)} / {number(amount)}{total === amount && <Check size={13} aria-hidden="true" />}</strong></h3>
            {entries.length ? <div className={styles.fishList}>{entries.map(entry => {
              const count = choice.selection[entry.itemId] ?? 0, unknown = entry.itemId === classId;
              const name = unknown ? "Без указания вида" : itemName(state, entry.itemId);
              return <div key={entry.itemId} className={styles.fish} data-selected={count > 0 || undefined} data-fish-choice={entry.itemId}>
                <button type="button" className={styles.add} disabled={locked(economy) || submitting || count >= entry.quantity}
                  aria-label={`Добавить: ${name}`} onClick={() => change(entry.itemId, classId, 1)}><ItemIcon itemId={entry.itemId} size={32} />
                  <span><strong>{name}</strong><small>В запасе {number(entry.quantity)}</small></span><b aria-label={`Выбрано: ${number(count)}`}>{number(count)}</b></button>
                <button type="button" className={styles.minus} disabled={locked(economy) || submitting || !count}
                  aria-label={`Убрать одну: ${name}`} onClick={() => change(entry.itemId, classId, -1)}><Minus size={15} aria-hidden="true" /></button>
              </div>;
            })}</div> : <p className={styles.empty}>Нет рыбы этой редкости.</p>}
          </section>;
        })}</div>
        {notice && <p className={styles.notice} role="status">{notice}</p>}
        <button type="button" className={styles.confirm} data-fish-confirm disabled={!valid || locked(economy) || submitting} onClick={() => {
          const current = currentChoice();
          if (!current || !fishSelectionMatches(current.props.economy.snapshot, current.props.requiredItems, choice.selection)) {
            setNotice("Выбор изменился. Проверьте количество рыбы."); return;
          }
          sent.current = choice; setSubmitting(true);
          if (!current.props.onConfirm({ ...choice.selection })) { sent.current = null; setSubmitting(false); setNotice("Не удалось отправить. Проверьте условия и попробуйте ещё раз."); }
        }}>{confirmLabel}</button>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
