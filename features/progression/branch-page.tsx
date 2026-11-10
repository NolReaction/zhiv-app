"use client";

import { lazy, Suspense, useCallback, useId, useSyncExternalStore, type KeyboardEvent } from "react";
import { ArrowLeft, BookOpen, ChartNoAxesCombined, Gem, Sprout, Trees } from "lucide-react";
import Link from "next/link";
import { BranchSession } from "./ui/shell/branch-session";
import { branchLocation, navigateBranch, readBranchHash, serverBranchHash, subscribeBranchHash } from "./ui/shell/branch-navigation";
import styles from "./ui/shell/branch-page.module.css";

const Catalog = lazy(() => import("./ui/catalog/economy-panel").then(module => ({ default: module.EconomyPanel })));
const Development = lazy(() => import("./ui/development/development-panel").then(module => ({ default: module.DevelopmentPanel })));
const Analysis = lazy(() => import("./ui/analysis/economy-workbench").then(module => ({ default: module.EconomyWorkbench })));
const Rewards = lazy(() => import("./ui/rewards/rewards-panel").then(module => ({ default: module.RewardsPanel })));
const World = lazy(() => import("./ui/world/world-tree").then(module => ({ default: module.WorldTree })));
const sections = [
  { id: "catalog", name: "Каталог", icon: BookOpen },
  { id: "development", name: "Развитие", icon: Sprout },
  { id: "analysis", name: "Анализ", icon: ChartNoAxesCombined },
  { id: "rewards", name: "Награды", icon: Gem },
  { id: "world", name: "Карта связей", icon: Trees },
] as const;

export function BranchPage() {
  const hash = useSyncExternalStore(subscribeBranchHash, readBranchHash, serverBranchHash);
  const { section, itemId } = branchLocation(hash);
  const id = useId();
  const inspect = useCallback((item: string) => navigateBranch("catalog", item), []);
  function tabsKeys(event: KeyboardEvent<HTMLElement>) {
    const index = sections.findIndex(value => value.id === section);
    const next = event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : event.key === "ArrowRight" ? (index + 1) % sections.length : event.key === "ArrowLeft" ? (index + sections.length - 1) % sections.length : null;
    if (next === null) return;
    event.preventDefault(); navigateBranch(sections[next].id);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-branch-tab="${sections[next].id}"]`)?.focus();
  }
  return <BranchSession><main className={styles.page} data-view={section}>
    <header className={styles.header}><Link href="/" className={styles.back} aria-label="Вернуться в Я живой"><ArrowLeft size={18} aria-hidden="true" /></Link><div><span>Рабочая панель</span><h1>Хозяйство и баланс</h1></div><p>Каталог, правила и расчёты мира</p><Link href="/admin">Админка</Link></header>
    <nav className={styles.tabs} role="tablist" aria-label="Разделы рабочего стола" onKeyDown={tabsKeys}>{sections.map(({ id: key, name, icon: Icon }) => <button key={key} type="button" role="tab" id={`${id}-${key}-tab`} aria-controls={`${id}-${key}-panel`} aria-selected={section === key} tabIndex={section === key ? 0 : -1} data-branch-tab={key} onClick={() => navigateBranch(key)}><Icon size={17} aria-hidden="true" />{name}</button>)}</nav>
    <div className={styles.panel} role="tabpanel" id={`${id}-${section}-panel`} aria-labelledby={`${id}-${section}-tab`} tabIndex={0}>
      <Suspense fallback={<p className={styles.loading} role="status">Открываем раздел…</p>}>
        {section === "catalog" && <Catalog itemId={itemId} />}
        {section === "development" && <Development onInspectItem={inspect} />}
        {section === "analysis" && <Analysis onInspectItem={inspect} />}
        {section === "rewards" && <Rewards onInspectItem={inspect} />}
        {section === "world" && <World />}
      </Suspense>
    </div>
  </main></BranchSession>;
}
