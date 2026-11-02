"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowLeft, ArrowRight, Award, Backpack, BookOpen, Check, Cherry, Clock3, CupSoda, Fish, Flame, LockKeyhole, Search, Sparkles, X } from "lucide-react";
import type { ReadyEconomy } from "@/features/economy/sync/controller-state";
import type { WorldHelpContext } from "@/features/world/ui/help/world-help-types";
import { ProductIcon, itemName, number, Work, type StationNavigation } from "@/features/economy/ui/shared/world-economy-parts";
import { worldCostShortfalls, worldCountdown, worldItemAvailable, worldJobProgress, worldMaterialSource, worldRecipeAccessReason, worldRecipeCost, worldRecipeUnlockRequirements, type WorldRecipe } from "@/features/economy/ui/shared/world-stations";
import { worldRecipeDuration } from "@/features/economy/ui/stations/world-recipe-groups";
import { WorldProductionCard } from "@/features/economy/ui/production/world-production-card";
import { WorldProductionSlots } from "@/features/economy/ui/production/world-production-slots";
import { experimentDiscovered } from "@/features/economy/domain/craft-skill";
import { mealTimeExample, mealWorkDescription } from "./meal-speed-description";
import { CookingExperimentIcon } from "@/features/items/item-icon";
import { CraftSkillsCard } from "./craft-skills-card";
import { productionSlotCount } from "@/features/economy/domain/production-slots";
import { explorationActorId } from "@/features/economy/domain/actor-availability";
import { cookbookCategories, cookbookProducts, cookbookRarities, cookbookFishRarity, type CookbookCategory } from "./cookbook-recipes";
import { CookbookPot } from "./cookbook-pot";
import styles from "./world-cookbook.module.css";

const bookTabs = [...cookbookCategories, { id: "discoveries", label: "Опыты" }] as const;
type BookCategory = CookbookCategory | "discoveries";
const categoryIcons = { fish: Fish, drinks: CupSoda, desserts: Cherry, provisions: Backpack, discoveries: Sparkles };
type Selection = { focus: string | null; request: number; recipeId: string | null; category: BookCategory; queue: boolean };

export function WorldCookbook({ economy, recipes, focusedRecipeId, navigationRequest = 0, navigation, openPantry, onHelpContextChange, onOpenHelp, achievements }: {
  economy: ReadyEconomy; recipes: WorldRecipe[]; focusedRecipeId: string | null; navigation: StationNavigation;
  navigationRequest?: number;
  openPantry?: () => void; onHelpContextChange?: (context: WorldHelpContext) => void;
  onOpenHelp?: (context: WorldHelpContext) => void; achievements?: ReactNode;
}) {
  const state = economy.productionSnapshot ?? economy.snapshot;
  const products = [...cookbookProducts(state, recipes), ...recipes.filter(recipe => !recipe.retired && recipe.experiment && !experimentDiscovered(state, recipe)).map(recipe => ({ key: recipe.id, recipe, methods: [recipe], category: "discoveries" as const }))];
  const focused = products.find(product => product.methods.some(recipe => recipe.id === focusedRecipeId));
  const [selection, setSelection] = useState<Selection>({ focus: focusedRecipeId, request: navigationRequest, recipeId: focused?.recipe.id ?? null, category: focused?.category ?? "fish", queue: state.jobs.some(job => job.targetId === "dryer" && (job.kind === "construction" || !focused && job.kind === "production")) });
  const [query, setQuery] = useState("");
  const [availableOnly, setAvailableOnly] = useState(false);
  const [rarity, setRarity] = useState("all");
  const pendingClaims = useRef<{ owner: string; ids: Set<string> }>({ owner: state.ownerPublicId, ids: new Set() });
  const [result, setResult] = useState<{ owner: string; jobId: string; recipeId: string; successful: boolean } | null>(null);
  const lastCooking = economy.snapshot.progression?.skills?.lastCooking;
  useEffect(() => {
    if (pendingClaims.current.owner !== state.ownerPublicId) pendingClaims.current = { owner: state.ownerPublicId, ids: new Set() };
    if (lastCooking && pendingClaims.current.ids.delete(lastCooking.jobId)) setResult({ owner: state.ownerPublicId, ...lastCooking });
  }, [state.ownerPublicId, lastCooking]);
  const claimEconomy: ReadyEconomy = { ...economy, act: (...args) => {
    const tracked = economy.snapshot.jobs.filter(job => Boolean(job.cooking) && (args[0] === "claim_job" && args[1] === job.id || args[0] === "claim_production" && args[1] === job.targetId));
    for (const job of tracked) pendingClaims.current.ids.add(job.id);
    const accepted = economy.act(...args);
    if (accepted === false) for (const job of tracked) pendingClaims.current.ids.delete(job.id);
    return accepted;
  } };
  const resultRecipe = result?.owner === state.ownerPublicId ? recipes.find(recipe => recipe.id === result.recipeId) : undefined;
  const recipeTitle = (recipe: WorldRecipe) => recipe.experiment && !experimentDiscovered(state, recipe) ? recipe.experiment.title : itemName(state, Object.keys(recipe.rewards)[0]);
  const heading = useRef<HTMLHeadingElement>(null), listing = useRef<HTMLDivElement>(null);
  const lastTrigger = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  if (selection.focus !== focusedRecipeId || selection.request !== navigationRequest) {
    setSelection({ focus: focusedRecipeId, request: navigationRequest, recipeId: focused?.recipe.id ?? null, category: focused?.category ?? "fish", queue: false });
    setQuery(""); setAvailableOnly(false); setRarity("all");
  }
  const selected = products.find(product => product.recipe.id === selection.recipeId);
  const selectedRecipe = selected?.recipe;
  const jobs = state.jobs.filter(job => job.kind === "production" && job.targetId === "dryer");
  const ready = jobs.filter(job => !economy.pendingProductionIds?.includes(job.id) && worldJobProgress(state, job, economy.now).ready);
  const currentJob = jobs.find(job => !economy.pendingProductionIds?.includes(job.id) && !worldJobProgress(state, job, economy.now).ready);
  const construction = state.jobs.find(job => job.kind === "construction" && job.targetId === "dryer");
  const showQueue = selection.queue;
  const selectedRecipeId = selectedRecipe?.id;
  const confirmedRecipes = economy.snapshot.progression?.recipes ?? {};
  const activeRecipes = recipes.filter(recipe => !recipe.retired);
  const mastered = activeRecipes.filter(recipe => (confirmedRecipes[recipe.id] ?? 0) > 0).length;
  const cooked = economy.snapshot.catalog.recipes.filter(recipe => recipe.buildingId === "dryer").reduce((total, recipe) => total + (confirmedRecipes[recipe.id] ?? 0), 0);
  const available = (recipe: WorldRecipe) => !worldRecipeAccessReason(state, recipe) && !worldCostShortfalls(state, worldRecipeCost(state, recipe)).length;
  const categoryProducts = products.filter(product => product.category === selection.category);
  const filtered = categoryProducts.filter(product => (!availableOnly || available(product.recipe))
    && (!query.trim() || [recipeTitle(product.recipe), product.recipe.experiment?.hint ?? ""].join(" ").toLocaleLowerCase("ru-RU").includes(query.trim().toLocaleLowerCase("ru-RU")))
    && (selection.category !== "fish" || rarity === "all" || cookbookFishRarity(state, product.recipe) === rarity));
  const groups = selection.category === "fish" ? [...cookbookRarities.map(group => ({ ...group, products: filtered.filter(product => cookbookFishRarity(state, product.recipe) === group.id) })), { id: "prepared", label: "Блюда из заготовок", products: filtered.filter(product => !cookbookFishRarity(state, product.recipe)) }]
    : [{ id: selection.category, label: bookTabs.find(category => category.id === selection.category)!.label, products: filtered }];
  useEffect(() => { if (selectedRecipeId) heading.current?.focus({ preventScroll: true }); }, [selectedRecipeId, navigationRequest]);
  function selectCategory(category: BookCategory) { setSelection({ focus: focusedRecipeId, request: navigationRequest, recipeId: null, category, queue: false }); setRarity("all"); }
  function backToRecipes() {
    setSelection(value => ({ ...value, recipeId: null, queue: false }));
    requestAnimationFrame(() => (lastTrigger.current?.isConnected ? lastTrigger.current : listing.current)?.focus({ preventScroll: true }));
  }
  return <div className={styles.cookbook} data-campfire-catalog data-cookbook-view={showQueue ? "queue" : selectedRecipe ? "detail" : "recipes"}>
    <div className={styles.topline}>
      <div className={styles.kitchenSummary}><CookbookPot economy={economy} /><div><strong>{ready.length ? `Готово: ${ready.length}` : currentJob ? "На огне" : construction ? "Улучшаем костёр" : "Кухня у костра"}</strong><span>{currentJob ? `${currentJob.cooking || recipes.find(recipe => recipe.id === currentJob.recipeId)?.experiment ? "Кулинарный опыт" : itemName(state, Object.keys(currentJob.rewards)[0])} · ${worldCountdown(worldJobProgress(state, currentJob, economy.now).seconds)}` : `Освоено ${mastered} из ${activeRecipes.length} рецептов`}</span></div></div>
      <button type="button" className={styles.queueToggle} aria-pressed={showQueue} data-cookbook-queue onClick={() => setSelection(value => ({ ...value, queue: !value.queue }))}><Flame size={16} aria-hidden="true" /><span>{showQueue ? "К рецептам" : ready.length ? "Забрать" : "Готовится"}<b>{ready.length || `${jobs.length}/${productionSlotCount(state, "dryer")}`}</b></span></button>
    </div>
    {resultRecipe && result && <div className={styles.discoveryNotice} role="status" data-cooking-result={result.successful ? "success" : "failed"}>
      <Sparkles size={18} aria-hidden="true" /><span><strong>{result.successful ? `Получилось: ${recipeTitle(resultRecipe)}` : "Опыт не удался"}</strong><small>{result.successful ? "Рецепт записан в книгу. Можно готовить снова." : "Ингредиенты потрачены. Блюдо не получилось."}</small></span><button type="button" aria-label="Скрыть результат готовки" onClick={() => setResult(null)}><X size={16} aria-hidden="true" /></button>
    </div>}
    {showQueue ? <section className={styles.queue} aria-label="Готовка и места" tabIndex={-1}>
      {construction ? <Work economy={economy} job={construction} openPantry={openPantry} /> : <WorldProductionSlots economy={claimEconomy} stationId="dryer" openPantry={openPantry} />}
      <CraftSkillsCard state={economy.snapshot} cookingOnly />
      <div className={styles.achievements}><Award size={20} aria-hidden="true" /><div><strong>Лесная кухня</strong><p>Освоено {mastered} из {activeRecipes.length} рецептов · приготовлено {number(cooked)}</p></div>{achievements}</div>
    </section> : <>
      <div className={styles.categories} role="tablist" aria-label="Разделы книги рецептов">{bookTabs.map((category, index) => {
        const Icon = categoryIcons[category.id];
        return <button key={category.id} id={`${id}-${category.id}`} type="button" role="tab" aria-selected={selection.category === category.id} aria-controls={`${id}-recipes`} tabIndex={selection.category === category.id ? 0 : -1} onClick={() => selectCategory(category.id)} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % bookTabs.length : event.key === "ArrowLeft" ? (index + bookTabs.length - 1) % bookTabs.length : event.key === "Home" ? 0 : event.key === "End" ? bookTabs.length - 1 : null;
          if (next === null) return; event.preventDefault(); event.stopPropagation(); selectCategory(bookTabs[next].id); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
        }}><Icon size={17} aria-hidden="true" /><span>{category.label}</span></button>;
      })}</div>
      <div className={styles.workspace} role="tabpanel" id={`${id}-recipes`} aria-labelledby={`${id}-${selection.category}`} data-selected={Boolean(selectedRecipe)}>
        <div className={styles.browser} ref={listing} tabIndex={-1}>
          {selection.category === "discoveries" && <p className={styles.discoveryIntro}>Найдите новое сочетание. Название блюда появится после первого удачного опыта.</p>}
          <div className={styles.filters}><label className={styles.search}><Search size={15} aria-hidden="true" /><input type="search" aria-label="Найти рецепт" placeholder="Поиск" value={query} onChange={event => setQuery(event.target.value)} /></label><label className={styles.canCook}><input type="checkbox" checked={availableOnly} onChange={event => setAvailableOnly(event.target.checked)} />Есть ингредиенты</label></div>
          {selection.category === "fish" && <label className={styles.rarityFilter}>Рыба<select aria-label="Редкость рыбы в рецепте" value={rarity} onChange={event => setRarity(event.target.value)}><option value="all">Любая редкость</option>{cookbookRarities.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>}
          <div className={styles.recipeList} data-section-guide-target="workshop-recipes">{groups.filter(group => group.products.length > 0).map(group => <section key={group.id} data-cooking-group={selection.category} data-cookbook-rarity={selection.category === "fish" ? group.id : undefined}><h3 className={styles.groupHeading}>{group.label}<span>{group.products.length}</span></h3><div className={styles.recipeGrid}>{group.products.map(product => {
            const recipe = product.recipe, output = Object.keys(recipe.rewards)[0], access = worldRecipeAccessReason(state, recipe), hidden = recipe.experiment && !experimentDiscovered(state, recipe);
            return <button key={product.key} type="button" className={styles.recipe} data-cookbook-recipe={recipe.id} data-recipe-focused={recipe.id === focusedRecipeId || undefined} aria-pressed={selectedRecipe?.id === recipe.id} aria-label={`Рецепт: ${recipeTitle(recipe)}`} onClick={event => { lastTrigger.current = event.currentTarget; setSelection(value => ({ ...value, recipeId: recipe.id })); onHelpContextChange?.({ stationId: "dryer", intent: "production", recipeId: recipe.id, quantity: 1 }); }}>{hidden ? <CookingExperimentIcon recipeId={recipe.id} size={35} /> : <ProductIcon state={state} itemId={output} size={35} />}<span><strong>{recipeTitle(recipe)}</strong>{recipe.fishInput?.exactSpecies && <em className={styles.signature}>Фирменное</em>}<small><Clock3 size={11} aria-hidden="true" />{worldRecipeDuration(recipe.seconds)}{access ? <LockKeyhole size={12} aria-label="Есть условия открытия" /> : available(recipe) ? <Check size={13} aria-label="Есть ингредиенты" /> : null}</small></span></button>;
          })}</div></section>)}{!filtered.length && <p className={styles.empty}>Нет подходящих рецептов. Попробуйте другой раздел или фильтр.</p>}</div>
        </div>
        {selectedRecipe ? <section className={styles.detail} aria-label={`Рецепт: ${recipeTitle(selectedRecipe)}`}>
          <div className={styles.detailScroll}><button type="button" className={styles.back} onClick={backToRecipes}><ArrowLeft size={15} aria-hidden="true" />Все рецепты</button><CookbookRecipeDetails economy={economy} recipe={selectedRecipe} navigation={navigation} headingRef={heading} />
            {onOpenHelp && <button type="button" className={styles.helpLink} onClick={() => onOpenHelp({ stationId: "dryer", intent: "production", recipeId: selectedRecipe.id, quantity: 1 })}><BookOpen size={14} aria-hidden="true" />Рецепт в справочнике<ArrowRight size={12} aria-hidden="true" /></button>}
          </div><div className={styles.cookFooter}><WorldProductionCard key={`${state.ownerPublicId}:${selectedRecipe.id}`} economy={economy} recipe={selectedRecipe} actionOnly onHelpContextChange={onHelpContextChange} focused={selectedRecipe.id === focusedRecipeId} />{jobs.length >= productionSlotCount(state, "dryer") && <button type="button" className={styles.helpLink} onClick={() => setSelection(value => ({ ...value, queue: true }))}>Все места заняты. Открыть готовку<ArrowRight size={12} aria-hidden="true" /></button>}</div>
        </section> : <div className={styles.placeholder}><BookOpen size={40} strokeWidth={1.2} aria-hidden="true" /><strong>Выберите рецепт</strong><p>Ингредиенты, польза и приготовление.</p><span>Освоено {mastered} из {activeRecipes.length}</span></div>}
      </div>
    </>}
  </div>;
}

function CookbookRecipeDetails({ economy, recipe, navigation, headingRef }: { economy: ReadyEconomy; recipe: WorldRecipe; navigation: StationNavigation; headingRef: RefObject<HTMLHeadingElement | null> }) {
  const state = economy.productionSnapshot ?? economy.snapshot, cost = worldRecipeCost(state, recipe);
  const outputs = Object.entries(recipe.rewards), meal = state.catalog.food?.meals.find(entry => (recipe.rewards[entry.itemId] ?? 0) > 0);
  const requirements = worldRecipeUnlockRequirements(state, recipe), access = worldRecipeAccessReason(state, recipe);
  const hidden = recipe.experiment && !experimentDiscovered(state, recipe);
  const costs = [...(cost.coins ? [["coins", cost.coins] as const] : []), ...Object.entries(cost.items)];
  return <>
    <header className={styles.recipeHero}><div>{hidden ? <CookingExperimentIcon recipeId={recipe.id} size={52} /> : outputs.map(([item, quantity]) => <span key={item}><ProductIcon state={state} itemId={item} size={52} /><b>×{number(quantity)}</b></span>)}</div><h3 ref={headingRef} tabIndex={-1}>{hidden ? recipe.experiment!.title : outputs.length === 1 ? itemName(state, outputs[0][0]) : recipe.name}</h3><span><Clock3 size={13} aria-hidden="true" />{worldRecipeDuration(recipe.seconds)}</span></header>
    {recipe.experiment && <p className={styles.experimentHint}>{recipe.experiment.hint}</p>}
    {access && <p className={styles.access} data-recipe-access><LockKeyhole size={14} aria-hidden="true" />{access}</p>}
    {requirements.length > 0 && <section className={styles.unlocks}><h4>{recipe.unlockTitle ?? "Для открытия"}</h4><ul>{requirements.map(requirement => <li key={`${requirement.kind}:${requirement.id}`} data-completed={requirement.completed}>{requirement.completed ? <Check size={13} aria-hidden="true" /> : <span className={styles.unchecked} />}<span>{requirement.label}</span><b>{number(requirement.current)} / {number(requirement.required)}</b></li>)}</ul></section>}
    <section className={styles.ingredients}><h4>Ингредиенты <span>есть / нужно</span></h4><ul>{costs.map(([item, quantity]) => {
      const stock = item === "coins" ? state.wallet.coins : worldItemAvailable(state, item), source = item === "coins" ? null : worldMaterialSource(state, item);
      const mining = source?.kind === "exploration" && state.catalog.explorations.some(route => route.id === source.targetId && explorationActorId(route) === "miner");
      const action = source?.kind === "production" && navigation.canOpen(source.stationId) ? () => navigation.open(source.stationId, source.targetId) : mining && navigation.canOpen("quarry") ? () => navigation.open("quarry") : source?.kind === "exploration" ? navigation.explore : undefined;
      return <li key={item} data-missing={stock < quantity}><ProductIcon state={state} itemId={item} size={22} /><span>{item === "coins" ? "Монеты" : itemName(state, item)}</span><b>{number(stock)} / {number(quantity)}</b>{action && <button type="button" aria-label={`Где получить: ${itemName(state, item)}`} onClick={action}><ArrowRight size={14} aria-hidden="true" /></button>}</li>;
    })}</ul>{cookbookFishRarity(state, recipe) && <p>{recipe.fishInput?.exactSpecies ? "Нужен именно этот вид рыбы." : "Подойдёт любая рыба этого класса."}</p>}</section>
    {!hidden && meal && <section className={styles.benefits} data-known-meal-benefits><h4>Поможет в работе</h4><p>Вылазка <strong>{mealTimeExample(meal.heroSpeedBps, meal.heroWorkSeconds)}</strong></p><small>{mealWorkDescription(meal.heroWorkSeconds)}</small><p>Одна стройка <strong>{mealTimeExample(meal.builderSpeedBps, meal.builderWorkSeconds, "builder")}</strong></p><small>{mealWorkDescription(meal.builderWorkSeconds, "builder")}</small><small>Пример для часа работы без других бонусов. В меню еды увидите точное время выбранного дела.</small></section>}
  </>;
}
