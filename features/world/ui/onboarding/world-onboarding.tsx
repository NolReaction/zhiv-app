"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { GuideCoach, type GuideCoachProps } from "@/features/onboarding/guide-coach";
import { WORLD_ONBOARDING_STEPS, type WorldOnboardingProgress, type WorldOnboardingStepId } from "@/features/world/domain/world-onboarding";
import { useForestObservation } from "@/features/world/state/use-forest-observation";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { isBerryProduction, berryCollectionStatus } from "@/features/economy/integration/garden-collection";
import { useGardenCollection } from "@/features/economy/integration/garden-collection-context";
import { canClaimWorkshopStarter, workshopStarterCost } from "@/features/economy/domain/workshop-starter";
import { worldConstructionReason, worldDuration, worldProductionReason } from "@/features/economy/ui/shared/world-stations";
import { WorldNeighborCards, WorkshopRetry, WorkshopStarterContents } from "./world-onboarding-cards";

export type WorldOnboardingProps = {
  open: boolean;
  modalBlocked: boolean;
  progress: WorldOnboardingProgress | null;
  worldElement: RefObject<HTMLElement | null>;
  economy: EconomyController;
  quickMenu: string | null;
  helpOpen: boolean;
  residentOpen: string | null;
  ordersOpen: boolean;
  workshopOpen: boolean;
  isOnline?: boolean;
  onStart: () => void;
  onStep: (stepId: WorldOnboardingStepId) => void;
  onCrop: (jobId: string | undefined) => void;
  onSkip: () => void;
  onComplete: () => void;
  onPause: () => void;
  onOpenQuick: (menu: "profile" | "pantry" | "expeditions") => void;
  onOpenGarden: (recipe?: string) => void;
  onOpenHelp: () => void;
  onOpenResident: (id: "plesk" | "builder") => void;
  onOpenOrders: () => void;
  onOpenWorkshop: (view?: "recipes") => void;
  onCloseSurface: () => void;
};

/** Track actual opened content, including choices made outside the coach. */
function usePracticeSurface(root: RefObject<HTMLElement | null>) {
  const [surface, setSurface] = useState({ garden: false, recipe: false, pantryItem: false, pantrySale: false, pantryRelics: false, routePreparation: false });
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const inspect = () => {
      const next = {
        garden: Boolean(element.querySelector('[data-place="garden"]')),
        recipe: Boolean(element.querySelector('[data-recipe-preparation="grow_berries"]')),
        pantryItem: Boolean(element.querySelector('[data-guide-pantry-item]')),
        pantrySale: Boolean(element.querySelector('[data-guide-pantry-sale]')),
        pantryRelics: Boolean(element.querySelector('[data-guide-pantry-relics]')),
        routePreparation: Boolean(element.querySelector('[data-route-preparation]')),
      };
      setSurface(previous => Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next);
    };
    inspect();
    const observer = new MutationObserver(inspect);
    observer.observe(element, { subtree: true, childList: true });
    return () => observer.disconnect();
  }, [root]);
  return surface;
}

/** Wait for the scene and yield to real modal dialogs without intercepting input. */
export function WorldOnboardingSession(props: WorldOnboardingProps & { presenceKey: string }) {
  const observation = useForestObservation(props.presenceKey);
  const blocked = observation?.memory.sync?.mode === "other-device";
  const [sceneReady, setSceneReady] = useState(false);
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    const element = props.worldElement.current;
    if (!element) return;
    const measure = () => {
      setSceneReady(Boolean(element.querySelector('[data-ready="true"] > canvas[role="img"]')));
      // Radix hides the map's ancestor when any nested modal (including audio
      // or a meal picker) owns focus. The guide must yield to that modal too.
      setCovered(Boolean(element.closest('[aria-hidden="true"]')));
    };
    const frame = requestAnimationFrame(measure);
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-ready", "aria-hidden"] });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [props.worldElement]);
  return <WorldOnboarding {...props} open={props.open && sceneReady && !blocked && !covered} />;
}

export function WorldOnboarding(props: WorldOnboardingProps) {
  const { progress, economy, worldElement, onStep, onCrop } = props;
  const surface = usePracticeSurface(worldElement);
  const collection = useGardenCollection();
  const current = progress?.status === "started" ? progress.stepId : null;
  const [visited, setVisited] = useState<string | null>(null);
  const [harvested, setHarvested] = useState(false);
  const previous = useRef<{ jobId?: string; revision: number; gainIds: Set<string> }>({ revision: -1, gainIds: new Set() });
  const snapshot = economy.snapshot;
  const tracked = snapshot?.jobs.find(job => job.id === progress?.cropJobId && isBerryProduction(job));
  const existing = snapshot?.jobs.filter(isBerryProduction).sort((a, b) => Date.parse(a.finishesAt) - Date.parse(b.finishesAt))[0];
  const crop = tracked ?? (current === "grow" ? existing : undefined);
  const berry = crop && snapshot ? berryCollectionStatus(crop, snapshot, economy.now, collection) : null;
  const recipe = snapshot?.catalog.recipes.find(item => item.id === "grow_berries");
  const reason = recipe && snapshot ? worldProductionReason(snapshot, recipe, 1) : null;
  const cropReady = Boolean(tracked && economy.now >= Date.parse(tracked.finishesAt));
  const reminder = progress?.status === "completed" && (cropReady || harvested);
  const advance = (next: WorldOnboardingStepId) => { props.onCloseSurface(); setVisited(null); props.onStep(next); };
  const finish = () => { setHarvested(false); props.onCloseSurface(); props.onComplete(); };
  // Remember an actual visit when the surface changes, including a modal help
  // visit whose coach is hidden. This does not move the user to another step.
  if (current && visited !== current && (props.quickMenu === current || current === "help" && props.helpOpen
    || current === "orders" && props.ordersOpen || current === "workshop" && props.workshopOpen)) setVisited(current);
  if (current === "profile" && harvested) setHarvested(false);
  useEffect(() => {
    if (current === "garden" && surface.recipe) onStep("grow");
    if (current === "grow" && crop && crop.id !== progress?.cropJobId) onCrop(crop.id);
  }, [current, surface.recipe, crop, progress?.cropJobId, onStep, onCrop]);
  useEffect(() => {
    if (!snapshot || economy.busy || economy.uncertain) return;
    const jobId = progress?.cropJobId;
    const before = previous.current;
    if (jobId && !tracked) {
      // A vanished job alone is not proof of a harvest (reload, another device,
      // developer reset). Celebrate only a new accepted garden inventory receipt.
      const accepted = before.jobId === jobId && (economy.inventoryGains ?? []).some(gain =>
        !before.gainIds.has(gain.id) && gain.ownerPublicId === snapshot.ownerPublicId && gain.revision > before.revision
        && gain.source === "claim" && gain.stationId === "garden" && gain.items.some(item => item.itemId === "berries" && item.quantity > 0));
      if (accepted) setHarvested(true);
      onCrop(undefined);
    }
    previous.current = { jobId: tracked?.id, revision: snapshot.revision, gainIds: new Set((economy.inventoryGains ?? []).map(gain => gain.id)) };
  }, [snapshot, economy.busy, economy.uncertain, economy.inventoryGains, progress?.cropJobId, tracked, onCrop]);

  if (progress?.status === "skipped" || progress?.status === "completed" && !reminder) return null;
  const index = WORLD_ONBOARDING_STEPS.findIndex(step => step.id === current);
  const step = WORLD_ONBOARDING_STEPS[index];
  const base: GuideCoachProps = {
    open: props.open && !props.modalBlocked, flow: "world", stepId: current ?? (reminder ? "harvest" : "welcome"),
    title: "Привет! Это наш лес", text: "Я Мохлик. За 3–5 минут посадим ягоды, познакомимся с соседями и заглянем в мастерскую. Всё можно открывать и пробовать.",
    summary: "Посадим ягоды и познакомимся с лесом за несколько минут.",
    hint: "Ждать урожай и стройку не придётся. Любой шаг можно отложить, а меня — погладить!",
    pose: "greet", welcome: !progress, targetRoot: worldElement,
    compact: Boolean(props.quickMenu || surface.garden || props.workshopOpen),
    onPause: props.onPause, onSkip: props.onSkip,
    primary: { label: "Давай попробуем", onClick: props.onStart },
  };
  if (step) {
    base.title = step.title; base.summary = step.summary; base.text = step.text; base.hint = step.hint; base.pose = step.pose;
    base.progress = { current: index + 1, total: WORLD_ONBOARDING_STEPS.length };
    base.onBack = index > 0 ? () => advance(WORLD_ONBOARDING_STEPS[index - 1].id) : undefined;
    base.secondary = { label: "Этот шаг позже", onClick: index < WORLD_ONBOARDING_STEPS.length - 1 ? () => advance(WORLD_ONBOARDING_STEPS[index + 1].id) : finish };
  }
  if (current === "profile" || current === "pantry" || current === "expeditions") {
    const labels = { profile: "Открыть профиль", pantry: "Открыть кладовую", expeditions: "Открыть «В путь»" };
    const next = { profile: "pantry", pantry: "garden", expeditions: "help" } as const;
    const opened = props.quickMenu === current;
    const seen = visited === current || opened;
    const contentTarget = { profile: '[data-guide-profile-tabs]',
      pantry: surface.pantryRelics ? '[data-guide-pantry-relics]' : surface.pantrySale ? '[data-guide-pantry-sale]'
        : surface.pantryItem ? '[data-guide-pantry-item]' : '[data-guide-pantry-capacity]',
      expeditions: '[data-route]' };
    base.target = opened ? contentTarget[current] : `[data-world-quick="${current}"]`;
    base.primary = seen ? { label: current === "pantry" ? "Попробуем вырастить ягоды" : "Посмотрел, дальше", onClick: () => advance(next[current]) }
      : { label: labels[current], onClick: () => props.onOpenQuick(current) };
    if (opened) {
      base.hint = undefined;
      if (current === "profile") {
        base.summary = "«Профиль» — достижения, «Настроение» — как я себя чувствую, «Друзья» — твои люди.";
        base.text = "Переключай вкладки: в профиле видны уровень и достижения, в настроении — моё состояние, в друзьях — люди, которых ты добавил в приложении. Осмотрись и продолжим.";
      } else if (current === "pantry") {
        base.summary = surface.pantryRelics ? "Реликвии нужны для улучшений и обмена. Быстро продать их нельзя."
          : surface.pantrySale ? "Если предмет можно продать, выбери количество и проверь итог перед «Продать торговцу»."
          : surface.pantryItem ? "Нажми на предмет: там условия быстрой продажи за монеты. Сейчас можно только посмотреть."
          : "Здесь будут припасы. Нажатие на обычный предмет откроет его быструю продажу.";
        base.text = surface.pantryRelics ? "Эти находки пригодятся для улучшений. Их можно обменивать с другими игроками; условия обмена показаны на рынке. Быстрой продажи торговцу для реликвий нет."
          : "Нажми на обычный предмет, выбери количество и проверь сумму перед кнопкой «Продать торговцу». Некоторые предметы не продаются, а для других нужно набрать минимальное количество — условия будут рядом. «Рынок» — отдельная торговля с игроками: можно покупать у других и выставлять свой товар, ожидая покупателя.";
        base.hint = "Продавать ради знакомства необязательно. Счётчик места показывает, сколько ещё поместится в кладовой.";
      } else {
        base.summary = surface.routePreparation ? "Здесь стоимость, время и находки. Отправка начнётся только по кнопке «Отправиться»."
          : "Нажми на маршрут, чтобы посмотреть стоимость, время и находки.";
        base.text = "Вылазки приносят припасы для рецептов и стройки. Выбери карточку маршрута и посмотри подготовку: стоимость, время и добычу видно до отправки. Начинать вылазку ради знакомства не нужно.";
      }
    } else if (seen) {
      base.summary = "Можно открыть раздел ещё раз или продолжить знакомство.";
    }
  }
  if (current === "garden") {
    base.target = surface.garden ? '[data-recipe="grow_berries"]' : undefined;
    base.text = surface.garden ? "Выбери обычные ягоды. На карточке видно, сколько получится и сколько ждать."
      : "Начнём с настоящего урожая. Нажми на ягодный куст на карте или на кнопку ниже — она откроет тот же куст.";
    base.summary = surface.garden ? "Нажми на обычные ягоды: откроется рецепт с временем и наградой." : "Откроем ягодный куст и посадим первый урожай.";
    base.primary = surface.garden ? { label: "Выбрать ягоды", onClick: () => worldElement.current?.querySelector<HTMLButtonElement>('[data-recipe="grow_berries"]')?.click() }
      : { label: "Показать ягодный куст", onClick: () => props.onOpenGarden() };
  }
  if (current === "grow" || reminder) {
    base.stepId = reminder ? "harvest" : "grow";
    base.title = harvested ? "Урожай в кладовой!" : crop ? berry?.growing ? "Ягоды уже растут" : "Пора собрать ягоды" : "Посади первые ягоды";
    base.pose = harvested ? "jump" : crop ? "present" : "wonder";
    base.summary = harvested ? "Ягоды получены в кладовую. Первый урожай твой!"
      : crop ? berry?.growing ? "Ягоды растут сами. Можно продолжать знакомство — о сборе напомню."
      : "Нажми «Собрать» у ягод и дождись, пока я отнесу урожай в кладовую."
      : recipe ? "Нажми «Начать» в карточке ягод. Дождись подтверждения выращивания."
      : "Рецепты ещё загружаются. Можно отложить этот шаг.";
    base.text = harvested ? "Получение подтверждено: ягоды попали в кладовую. Ты прошёл весь путь — выбрал рецепт, вырастил и собрал урожай."
      : crop ? berry?.growing ? `Заказ появился в хозяйстве. До урожая ещё ${worldDuration(Math.max(1, Math.ceil((Date.parse(crop.finishesAt) - economy.now) / 1000)))}. Можно закрыть карту: ягоды продолжат расти.`
      : "Нажми «Собрать» у ягод. Я подойду к кусту, соберу урожай и отнесу его в кладовую. Если сбор уже начат, дай мне закончить."
      : recipe ? `В этом рецепте получится ${recipe.rewards.berries ?? 0} ягоды за ${worldDuration(recipe.seconds)}. ${recipe.cost.coins === 0 && !Object.keys(recipe.cost.items).length ? "Монеты и материалы не нужны." : "Перед запуском проверь стоимость в рецепте."} Нажми настоящую кнопку «Начать» в карточке.`
      : "Сначала нужно загрузить рецепты хозяйства. Пока можно осмотреть карту или вернуться к этому шагу позже.";
    base.hint = harvested ? "Теперь так же можно создавать другие продукты и материалы."
      : crop && berry?.growing ? "После знакомства я напомню о сборе на карте, когда урожай созреет. Ждать здесь не нужно."
      : "Кнопка в карточке работает как обычно. Если не хватает места или Мохлик занят, причина показана рядом.";
    base.target = crop ? berry?.growing ? undefined : `[data-job-id="${crop.id}"] button` : '[data-recipe-preparation="grow_berries"] [data-recipe-order] > button';
    if (harvested) {
      base.primary = { label: "Посмотреть ягоды", onClick: () => { if (reminder) setHarvested(false); else advance("neighbors"); props.onOpenQuick("pantry"); } };
    } else if (crop && berry?.growing) {
      base.primary = { label: "Продолжить знакомство", onClick: () => advance("neighbors") };
    } else if (crop) {
      base.primary = surface.garden ? undefined
        : { label: "Открыть урожай", onClick: () => props.onOpenGarden() };
      base.status = berry?.collecting ? berry.label : berry?.awayReason ?? (snapshot && Object.values(crop.rewards).reduce((sum, amount) => sum + amount, 0) > snapshot.storage.available ? "В кладовой мало места. Освободи его и вернись к сбору." : undefined);
    } else {
      base.primary = surface.recipe ? undefined
        : { label: "Открыть рецепт ягод", onClick: () => props.onOpenGarden("grow_berries") };
      base.status = props.isOnline === false ? "Сейчас нет связи. Запустить выращивание можно после подключения." : economy.uncertain ? "Запрос ещё не подтверждён. Проверь его результат в хозяйстве." : economy.error ?? reason ?? undefined;
    }
    if (reminder) {
      base.progress = undefined; base.onBack = undefined;
      base.secondary = harvested ? undefined : { label: "К кладовой", onClick: () => props.onOpenQuick("pantry") };
      base.onSkip = () => { setHarvested(false); props.onCrop(undefined); };
    }
  }
  if (current === "neighbors") {
    base.text = "Плёска знает всё о рыбалке, а ёжик Шишколап берётся за стройку. Нажми на соседа, если хочешь поговорить.";
    base.hint = "Покупать ничего не нужно. Соседи всегда доступны на карте и в списке персонажей.";
    base.children = <WorldNeighborCards onOpenResident={props.onOpenResident} />;
    base.primary = { label: "Дальше, к заказам", onClick: () => advance("orders") };
    base.secondary = undefined;
    // A resident conversation owns its own controls and focus until it closes.
    base.open = base.open && !props.residentOpen;
  }
  if (current === "orders") {
    const seen = visited === "orders" || props.ordersOpen;
    base.target = props.ordersOpen ? '[data-order-id]' : undefined;
    base.summary = props.ordersOpen ? "На карточке: «есть / нужно» и награда. Нажми на недостающий ресурс, чтобы узнать, где его взять."
      : seen ? "Заказ можно выполнить позже, когда появятся припасы." : "Соседи платят монетами за еду и материалы. Посмотрим один заказ.";
    base.text = seen ? "На карточке видно, что просит сосед: числа у припасов — сколько есть и сколько нужно, монеты справа — награда. Нажимаемый недостающий ресурс откроет место его получения. «Отдать заказ» передаёт припасы соседу; выполнять заказ ради знакомства не нужно."
      : "Соседи заказывают рыбу, еду и материалы и платят за них монетами. Заглянем на доску заказов?";
    base.hint = "Готовить и выполнять заказ сейчас не нужно. Вернёшься, когда будут припасы.";
    base.primary = seen ? { label: "К мастерской", onClick: () => advance("workshop") }
      : { label: "Посмотреть заказы", onClick: props.onOpenOrders };
    base.secondary = seen ? undefined : { label: "Дальше", onClick: () => advance("workshop") };
  }
  if (current === "workshop") {
    const building = snapshot?.catalog.buildings.find(item => item.id === "workshop");
    const level = snapshot?.buildings.workshop ?? 0;
    const construction = snapshot?.jobs.find(job => job.kind === "construction" && job.targetId === "workshop");
    const first = building?.levels.find(item => item.level === 1);
    const next = building?.levels.find(item => item.level === level + 1);
    const giftAvailable = Boolean(snapshot && first && canClaimWorkshopStarter(snapshot));
    const cost = snapshot && first ? workshopStarterCost(snapshot.catalog) : null;
    const storageShort = Boolean(snapshot && cost && Object.values(cost.items).reduce((sum, count) => sum + count, 0) > snapshot.storage.available);
    const offline = props.isOnline === false;
    const locked = offline || economy.busy || economy.uncertain || economy.retryAt > economy.now;
    const constructionReason = snapshot && next ? worldConstructionReason(snapshot, "workshop", next) : undefined;
    base.hint = "Стройка запускается отдельно, только по твоему нажатию. Ждать здесь не нужно.";
    base.secondary = { label: "К вылазкам", onClick: () => advance("expeditions") };
    base.target = undefined;
    base.children = <>{giftAvailable && <WorkshopStarterContents economy={economy} onOpenPantry={storageShort ? () => props.onOpenQuick("pantry") : undefined} />}<WorkshopRetry economy={economy} isOnline={props.isOnline} /></>;
    base.status = offline ? "Сейчас нет связи. Можно продолжить знакомство и вернуться позже."
      : economy.uncertain ? "Ответ ещё не подтверждён. Проверим результат, прежде чем выдавать новый набор."
      : economy.busy ? "Жду подтверждения хозяйства…"
      : economy.error ?? (giftAvailable && storageShort ? "Для набора нужно освободить место в кладовой." : undefined);
    if (!snapshot || !first) {
      base.title = "Мастерская для новых идей";
      base.summary = "Мастерская создаёт материалы для построек. Подождём загрузки хозяйства.";
      base.text = "Здесь делают доски, верёвки и материалы для новых построек. Загружаю хозяйство, чтобы показать твой следующий шаг.";
      base.primary = { label: "Обновить хозяйство", onClick: () => void economy.refresh(), disabled: locked };
    } else if (construction) {
      const remaining = Math.max(0, Math.ceil((Date.parse(construction.finishesAt) - economy.now) / 1000));
      base.title = remaining ? "Шишколап уже строит!" : "Мастерская почти готова";
      base.summary = remaining ? "Стройка началась. Можно идти дальше, ждать у здания не нужно." : "Время стройки закончилось. Открой постройку, чтобы проверить результат.";
      base.pose = "jump";
      base.text = remaining ? `Заказ принят. До готовности ещё ${worldDuration(remaining)}; можно уйти с карты и заняться своими делами.`
        : "Время стройки закончилось. Открой постройку, чтобы проверить результат. А мы можем продолжить прогулку.";
      base.primary = { label: "Продолжить знакомство", onClick: () => advance("expeditions") };
      base.secondary = { label: "Посмотреть стройку", onClick: props.onOpenWorkshop };
    } else if (level > 0) {
      base.title = "Мастерская уже есть";
      base.summary = next ? "Улучшение мастерской открывает новые рецепты. Посмотрим требования?" : "Мастерская уже максимального уровня. Можно изучить рецепты.";
      base.pose = "present";
      base.text = `У тебя мастерская ${level}-го уровня. ${next ? "Улучшение открывает новые рецепты — заглянем в требования?" : "Она уже достигла максимального уровня. Можно посмотреть доступные рецепты."}`;
      base.hint = next ? `Следующее улучшение занимает ${worldDuration(next.seconds)}. Его можно запланировать на потом.` : "Доски, верёвки и другие материалы пригодятся для развития леса.";
      base.primary = { label: next ? "Посмотреть улучшение" : "Открыть мастерскую", onClick: () => props.onOpenWorkshop(next ? undefined : "recipes") };
      base.status ??= constructionReason ?? undefined;
    } else if (snapshot.workshopStarterClaimed) {
      base.title = "Набор для мастерской получен";
      base.summary = "Набор получен. Открой план постройки — запуск стройки подтвердим отдельно.";
      base.pose = "jump";
      base.text = `Материалы и монеты начислены. Открой план постройки: Шишколап построит мастерскую за ${worldDuration(first.seconds)}. Запуск — в следующем окне.`;
      base.primary = { label: "Построим мастерскую?", onClick: props.onOpenWorkshop };
      base.status ??= constructionReason ?? undefined;
    } else {
      base.title = "Подарок на первую мастерскую";
      base.summary = "Дарю материалы и монеты на первую мастерскую. Нажми «Получить набор».";
      base.pose = "present";
      base.text = "Здесь будем делать доски и верёвки. За знакомство дарю полный набор на первую постройку: твои накопления останутся при тебе.";
      base.primary = { label: "Получить набор", disabled: locked || !giftAvailable || storageShort,
        onClick: () => { if (!locked && giftAvailable && !storageShort) void economy.act("claim_workshop_starter", "workshop"); } };
    }
  }
  if (current === "help") {
    const construction = snapshot?.jobs.find(job => job.kind === "construction" && job.targetId === "workshop");
    const workshopLevel = snapshot?.buildings.workshop ?? 0;
    const cropResult = tracked ? cropReady ? "Ягоды готовы к сбору." : "Ягоды растут."
      : harvested ? "Первый урожай уже в кладовой." : "Ягоды можно посадить в любое время.";
    const workshopResult = !snapshot ? "Хозяйство ещё загружается." : construction ? economy.now >= Date.parse(construction.finishesAt)
      ? "Время стройки мастерской закончилось — проверь результат." : workshopLevel > 0 ? "Мастерская улучшается." : "Мастерская строится."
      : workshopLevel > 0 ? `Мастерская работает: уровень ${workshopLevel}.`
      : snapshot?.workshopStarterClaimed ? "Набор для мастерской получен, стройка ещё не запущена." : "Набор для первой мастерской можно получить, вернувшись к её шагу.";
    base.target = '[data-world-onboarding-help]';
    base.summary = `${cropResult} ${workshopResult}`;
    base.text = `${cropResult} ${workshopResult} Кнопка i открывает справку, а «Ещё» → «Обучение» возвращает знакомство с лесом.`;
    base.hint = "В новых разделах я коротко объясню местные действия. Выращивание и стройка продолжаются в фоне.";
    base.pose = "greet";
    base.primary = { label: "Готово, буду играть", onClick: finish };
    base.secondary = { label: "Открыть справку", onClick: props.onOpenHelp };
    if (tracked && cropReady) base.secondary = { label: "Закончить и собрать ягоды", onClick: () => { finish(); props.onOpenGarden(); } };
    else if (snapshot?.workshopStarterClaimed && !workshopLevel && !construction) {
      base.secondary = { label: "Закончить и открыть стройку", onClick: () => { finish(); props.onOpenWorkshop(); } };
    }
  }
  return <GuideCoach {...base} />;
}
