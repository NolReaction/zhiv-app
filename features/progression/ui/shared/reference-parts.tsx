"use client";

import { ArrowRight, Sprout } from "lucide-react";
import { PlayerItemIcon } from "@/features/economy/ui/fishing/fish-discovery";
import { recipeResultName } from "@/features/economy/domain/recipe-prerequisites";

import { progressionEconomy, type EconomyItemSource, type EconomyRecipe } from "@/features/progression/domain/economy-data";
import styles from "@/features/progression/ui/shared/economy-reference.module.css";

export const data = progressionEconomy;
export const byId = new Map(data.items.map(item => [item.id, item]));
export const recipeById = new Map(data.recipes.map(recipe => [recipe.id, recipe]));
export const number = (value: number) => value.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
export const signed = (value: number) => `${value > 0 ? "+" : ""}${number(value)}`;
export const searchWords = (value: string) => value.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
export const categoryNames: Record<string, string> = { produce: "Урожай", material: "Материалы", crafted: "Переработка", provisions: "Еда и запасы", raw: "Рыба по классам", fishing: "Наживка", special: "Реликвии" };
export const sourceNames = { starter: "Старт", recipe: "Производство", exploration: "Добыча", fishing: "Рыбалка", rare: "Находка", daily: "Подарок", project: "Проект дома", shop: "Лавка" };
export const useNames = { recipe: "Рецепт", building: "Стройка", order: "Повторяемый заказ", weekly: "Недельное поручение", project: "Поставка дома", meal: "Бонус еды", fishing: "Рыбалка", exploration: "Вылазка" };

export function RecipeDiscovery({ source }: { source: Pick<EconomyItemSource, "requiredRecipes" | "requiredExplorations" | "requiredFishCaught" | "unlockTitle"> }) {
  const conditions = [
    ...Object.entries(source.requiredRecipes ?? {}).map(([id, count]) => `Сначала получить: ${recipeResultName(id, data)} ×${count}`),
    ...Object.entries(source.requiredExplorations ?? {}).map(([id, count]) => `Завершить «${data.routeNames[id] ?? id}» ×${count}`),
    ...(source.requiredFishCaught ? [`Лично поймать ${number(source.requiredFishCaught)} рыб`] : []),
  ];
  return conditions.length ? <p className={styles.hint}>{source.unlockTitle && <strong>{source.unlockTitle}: </strong>}{conditions.join(" · ")}</p> : null;
}

export function time(seconds: number) {
  if (seconds <= 0) return "Мгновенно";
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60), rest = Math.round(seconds % 60);
  return [days && `${number(days)} дн.`, hours && `${hours} ч`, minutes && `${minutes} мин`, rest && `${rest} с`].filter(Boolean).join(" ");
}

export function ItemAmount({ id, count, onSelect }: { id: string; count: number; onSelect: (id: string) => void }) {
  return <button type="button" className={styles.ingredient} onClick={() => onSelect(id)} title={`Открыть: ${byId.get(id)?.name ?? id}`}>
    <PlayerItemIcon itemId={id} size={23} /><span>{byId.get(id)?.name ?? id}</span><b>×{number(count)}</b>
  </button>;
}

export function Ingredients({ items, onSelect }: { items: Record<string, number>; onSelect: (id: string) => void }) {
  return <div className={styles.ingredients}>{Object.entries(items).map(([id, count]) => <ItemAmount key={id} id={id} count={count} onSelect={onSelect} />)}</div>;
}

export function RecipeFlow({ recipe, runs = 1, onSelect }: { recipe: EconomyRecipe; runs?: number; onSelect: (id: string) => void }) {
  return <div className={styles.flow}>
    <div>{Object.keys(recipe.cost.items).length ? <Ingredients items={Object.fromEntries(Object.entries(recipe.cost.items).map(([id, count]) => [id, count * runs]))} onSelect={onSelect} /> : <span className={styles.freeInput}><Sprout size={17} aria-hidden="true" />Сбор без ингредиентов</span>}
      {!!recipe.cost.coins && <small>{number(recipe.cost.coins * runs)} монет</small>}</div>
    <ArrowRight className={styles.flowArrow} size={20} aria-label={recipe.experiment ? "При удаче" : "Получится"} />
    <Ingredients items={Object.fromEntries(Object.entries(recipe.rewards).map(([id, count]) => [id, count * runs]))} onSelect={onSelect} />
  </div>;
}
