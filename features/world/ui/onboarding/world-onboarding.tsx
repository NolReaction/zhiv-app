"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { GuideCoach, type GuideCoachProps } from "@/features/onboarding/guide-coach";
import { progressionRewardsCatalog } from "@/features/game/progression-rewards";
import { formatPearls } from "@/features/economy/domain/money";
import { worldOnboardingNeedsHarvest, WORLD_ONBOARDING_STEPS, type WorldOnboardingProgress, type WorldOnboardingStepId } from "@/features/world/domain/world-onboarding";
import { useForestObservation } from "@/features/world/state/use-forest-observation";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { isBerryProduction, berryCollectionStatus } from "@/features/economy/integration/garden-collection";
import { useGardenCollection } from "@/features/economy/integration/garden-collection-context";
import { canStartTutorialWorkshop } from "@/features/economy/domain/workshop-starter";
import { canPrepareTutorialHarvest, TUTORIAL_ORDER_ID, tutorialOrderProgress, tutorialResidentOrder } from "@/features/economy/domain/tutorial-order";
import { worldConstructionReason, worldDuration, worldProductionReason } from "@/features/economy/ui/shared/world-stations";
import { worldRecipeDuration, worldRecipeGroups } from "@/features/economy/ui/stations/world-recipe-groups";
import { TutorialOrderContents, WorkshopRetry, WorkshopConstructionContents, tutorialWorkshopAction } from "./world-onboarding-cards";

export type WorldOnboardingProps = {
  open: boolean;
  modalBlocked: boolean;
  progress: WorldOnboardingProgress | null;
  worldElement: RefObject<HTMLElement | null>;
  ordersElement?: RefObject<HTMLElement | null>;
  economy: EconomyController;
  quickMenu: string | null;
  helpOpen: boolean;
  residentOpen: string | null;
  charactersOpen?: boolean;
  ordersOpen: boolean;
  /** A nonmodal fish sale owns the controls while the lesson stays mounted. */
  fishSaleOpen?: boolean;
  workshopOpen: boolean;
  isOnline?: boolean;
  onStart: () => void;
  onStep: (stepId: WorldOnboardingStepId, completeCurrent?: boolean) => void;
  onCrop: (jobId: string | undefined) => void;
  onHarvest: (jobId: string) => void;
  onSkip: () => void;
  onComplete: () => void;
  onOpenHelp: () => void;
  onPause: () => void;
  onCloseSurface: () => void;
};

/** Track actual opened content, including choices made outside the coach. */
function usePracticeSurface(root: RefObject<HTMLElement | null>) {
  const [surface, setSurface] = useState({ garden: false, recipe: false, pantryItem: false, pantrySale: false, pantryRelics: false,
    routeActivities: false, routes: false, routePreparation: false, tutorialOrder: false, workshopSelected: false });
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const inspect = () => {
      const next = {
        garden: Boolean(element.querySelector('[data-place="garden"]')),
        recipe: Boolean(element.querySelector('[data-place="garden"] [data-recipe-product="berries"]')),
        pantryItem: Boolean(element.querySelector('[data-guide-pantry-item]')),
        pantrySale: Boolean(element.querySelector('[data-guide-pantry-sale]')),
        pantryRelics: Boolean(element.querySelector('[data-guide-pantry-relics]')),
        routeActivities: Boolean(element.querySelector('[data-section-guide-target="expedition-activities"]')),
        routes: Boolean(element.querySelector('[data-section-guide-target="expedition-routes"]')),
        routePreparation: Boolean(element.querySelector('[data-route-preparation]')),
        tutorialOrder: Boolean(element.querySelector('[data-tutorial-order="true"]')),
        workshopSelected: Boolean(element.querySelector('[data-place="workshop"] [role="tab"][aria-selected="true"][id$="-workshop"]')),
      };
      setSurface(previous => Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next);
    };
    inspect();
    const observer = new MutationObserver(inspect);
    observer.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-selected"] });
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
      // The journal lives in a portal that intentionally hides the map. Its
      // coach belongs to that dialog and yields when a nested picker hides it.
      const activeElement = props.ordersOpen ? props.ordersElement?.current ?? element : element;
      setCovered(Boolean(activeElement.closest('[aria-hidden="true"]')));
    };
    const frame = requestAnimationFrame(measure);
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-ready", "aria-hidden"] });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [props.worldElement, props.ordersElement, props.ordersOpen]);
  return <WorldOnboarding {...props} open={props.open && sceneReady && !blocked && !covered && !props.fishSaleOpen} />;
}

export function WorldOnboarding(props: WorldOnboardingProps) {
  const { progress, economy, worldElement, onStep, onCrop, onHarvest, onCloseSurface } = props;
  const practiceRoot = props.ordersOpen ? props.ordersElement ?? worldElement : worldElement;
  const surface = usePracticeSurface(practiceRoot);
  const collection = useGardenCollection();
  const current = progress?.status === "started" ? progress.stepId : null;
  const [visited, setVisited] = useState<string | null>(null);
  const [harvestOwner, setHarvestOwner] = useState<string | null>(null);
  const [saleOwner, setSaleOwner] = useState<string | null>(null);
  const previousSale = useRef({ owner: economy.snapshot?.ownerPublicId, step: current,
    id: economy.localSale?.id, revision: economy.snapshot?.revision ?? -1 });
  const previous = useRef<{ owner?: string; jobId?: string; revision: number; gainIds: Set<string> }>({ revision: -1, gainIds: new Set() });
  const orderPinSent = useRef(false);
  const previousDeparture = useRef({ owner: economy.snapshot?.ownerPublicId, step: current,
    id: economy.localExploration?.id, revision: economy.snapshot?.revision ?? -1 });
  const snapshot = economy.snapshot;
  const harvested = progress?.status === "started" && progress.harvested === true || Boolean(harvestOwner && harvestOwner === snapshot?.ownerPublicId);
  const order = snapshot ? tutorialResidentOrder(snapshot) : null;
  const practice = snapshot ? tutorialOrderProgress(snapshot) : null;
  const lessonDone = Boolean(practice && (practice.completed || practice.step > 0));
  const harvestForOrder = worldOnboardingNeedsHarvest(progress, order, lessonDone);
  const tracked = snapshot?.jobs.find(job => job.id === progress?.cropJobId && isBerryProduction(job) && (job.rewards.berries ?? 0) > 0);
  const existing = snapshot?.jobs.filter(job => isBerryProduction(job) && (job.rewards.berries ?? 0) > 0)
    .sort((a, b) => Date.parse(a.finishesAt) - Date.parse(b.finishesAt))[0];
  const crop = tracked ?? (!progress?.cropJobId && (current === "grow" || harvestForOrder) && !harvested ? existing : undefined);
  const berry = crop && snapshot ? berryCollectionStatus(crop, snapshot, economy.now, collection) : null;
  const recipe = snapshot ? worldRecipeGroups(snapshot, snapshot.catalog.recipes.filter(item => item.buildingId === "garden"))
    .find(group => (group.recipe.rewards.berries ?? 0) > 0)?.recipe : undefined;
  const reason = recipe && snapshot ? worldProductionReason(snapshot, recipe, 1) : null;
  const firstHarvest = Boolean(recipe && snapshot && canPrepareTutorialHarvest(snapshot, recipe.id));
  const cropReady = Boolean(tracked && economy.now >= Date.parse(tracked.finishesAt));
  const reminder = progress?.status === "completed" && (cropReady || Boolean(harvestOwner && harvestOwner === snapshot?.ownerPublicId));
  const advance = (next: WorldOnboardingStepId, completeCurrent = true) => { onCloseSurface(); setVisited(null); setSaleOwner(null); props.onStep(next, completeCurrent); };
  const finish = () => { setHarvestOwner(null); onCloseSurface(); props.onComplete(); };
  const pinOrder = () => {
    if (orderPinSent.current) return;
    orderPinSent.current = true;
    void economy.act("claim_tutorial_order", TUTORIAL_ORDER_ID);
  };
  useEffect(() => {
    if (!economy.busy && !economy.uncertain) orderPinSent.current = false;
  }, [economy.busy, economy.uncertain, economy.error, snapshot?.ownerPublicId, snapshot?.revision]);
  useEffect(() => {
    const before = previousSale.current;
    const sale = economy.localSale;
    if (before.owner !== snapshot?.ownerPublicId || before.step !== current) {
      setSaleOwner(null);
      previousSale.current = { owner: snapshot?.ownerPublicId, step: current, id: sale?.id, revision: snapshot?.revision ?? -1 };
      return;
    }
    if (economy.busy || economy.uncertain || !sale || sale.id === before.id
      || sale.ownerPublicId !== snapshot?.ownerPublicId || sale.revision > snapshot.revision) return;
    if (current === "pantry" && sale.revision > before.revision) {
      setSaleOwner(sale.ownerPublicId);
    }
    previousSale.current = { ...before, id: sale.id, revision: Math.max(before.revision, sale.revision) };
  }, [current, economy.localSale, economy.busy, economy.uncertain, snapshot?.ownerPublicId, snapshot?.revision]);
  // Remember an actual visit when the surface changes, including a modal help
  // visit whose coach is hidden. This does not move the user to another step.
  if (current && visited !== current && (props.quickMenu === current || current === "help" && props.helpOpen
    || current === "orders" && props.ordersOpen || current === "workshop" && props.workshopOpen
    || current === "neighbors" && (props.charactersOpen || props.residentOpen))) setVisited(current);
  if (current === "profile" && harvestOwner) setHarvestOwner(null);
  useEffect(() => {
    if (props.open && current === "garden" && surface.recipe) onStep("grow", true);
    if ((current === "grow" || harvestForOrder) && crop && crop.id !== progress?.cropJobId) onCrop(crop.id);
  }, [props.open, current, harvestForOrder, surface.recipe, crop, progress?.cropJobId, onStep, onCrop]);
  useEffect(() => {
    if (!snapshot || economy.busy || economy.uncertain) return;
    const jobId = progress?.cropJobId;
    const before = previous.current;
    if (jobId && !tracked) {
      // A vanished job alone is not proof of a harvest (reload, another device,
      // developer reset). Celebrate only a new accepted garden inventory receipt.
      const accepted = before.owner === snapshot.ownerPublicId && before.jobId === jobId && (economy.inventoryGains ?? []).some(gain =>
        !before.gainIds.has(gain.id) && gain.ownerPublicId === snapshot.ownerPublicId && gain.revision > before.revision && gain.revision <= snapshot.revision
        && gain.source === "claim" && gain.stationId === "garden" && gain.items.some(item => item.itemId === "berries" && item.quantity > 0));
      if (accepted) { setHarvestOwner(snapshot.ownerPublicId); onHarvest(jobId); }
      else onCrop(undefined);
    }
    previous.current = { owner: snapshot.ownerPublicId, jobId: tracked?.id, revision: snapshot.revision, gainIds: new Set((economy.inventoryGains ?? []).map(gain => gain.id)) };
  }, [snapshot, economy.busy, economy.uncertain, economy.inventoryGains, progress?.cropJobId, tracked, onCrop, onHarvest]);

  useEffect(() => {
    const before = previousDeparture.current, departure = economy.localExploration;
    if (before.owner !== snapshot?.ownerPublicId || before.step !== current) {
      previousDeparture.current = { owner: snapshot?.ownerPublicId, step: current,
        id: departure?.id, revision: snapshot?.revision ?? -1 };
      return;
    }
    if (economy.busy || economy.uncertain || !snapshot || !departure || departure.id === before.id
      || departure.ownerPublicId !== snapshot.ownerPublicId || departure.revision > snapshot.revision) return;
    if (props.open && current === "expeditions" && departure.revision > before.revision
      && snapshot.jobs.some(job => job.id === departure.jobId && job.kind === "exploration")) {
      onCloseSurface(); onStep("help", true);
    }
    previousDeparture.current = { ...before, id: departure.id, revision: Math.max(before.revision, departure.revision) };
  }, [props.open, current, snapshot, economy.localExploration, economy.busy, economy.uncertain, onStep, onCloseSurface]);

  if (progress?.status === "skipped" || progress?.status === "completed" && !reminder) return null;
  const index = WORLD_ONBOARDING_STEPS.findIndex(step => step.id === current);
  const step = WORLD_ONBOARDING_STEPS[index];
  const completionGift = `${formatPearls(progressionRewardsCatalog.onboarding.pearls)} жемчуга и ${progressionRewardsCatalog.onboarding.coins.toLocaleString("ru-RU")} монет`;
  const base: GuideCoachProps = {
    open: props.open && !props.modalBlocked, flow: "world", stepId: current ?? (reminder ? "harvest" : "welcome"),
    title: "Привет! Это наш лес", text: "Я Мохлик. За 3-5 минут посадим ягоды, познакомимся с соседями и заглянем в мастерскую. Всё можно открывать и пробовать.",
    summary: "Посадим ягоды и познакомимся с лесом за несколько минут.",
    hint: `За полное обучение получишь ${completionGift}. Любой шаг можно отложить и пройти позже: возможность получить подарок сохранится.`,
    pose: "greet", welcome: !progress, targetRoot: practiceRoot,
    compact: Boolean(props.ordersOpen || props.quickMenu || surface.garden || props.workshopOpen),
    dock: props.ordersOpen ? "[data-guide-coach-slot]" : props.quickMenu ? "#world-quick-menu [data-guide-coach-slot]" : surface.garden || props.workshopOpen ? "[data-place] [data-guide-coach-slot]" : undefined,
    onPause: props.onPause, onSkip: props.onSkip,
    primary: { label: "Давай попробуем", onClick: props.onStart },
  };
  if (step) {
    base.title = step.title; base.summary = step.summary; base.text = step.text; base.hint = step.hint; base.pose = step.pose;
    base.progress = { current: index + 1, total: WORLD_ONBOARDING_STEPS.length };
    base.primary = undefined;
    base.onBack = index > 0 ? () => advance(WORLD_ONBOARDING_STEPS[index - 1].id, false) : undefined;
    base.secondary = { label: "Этот шаг позже", onClick: index < WORLD_ONBOARDING_STEPS.length - 1 ? () => advance(WORLD_ONBOARDING_STEPS[index + 1].id, false) : finish };
  }
  if (current === "profile" || current === "pantry" || current === "expeditions") {
    const next = { profile: "pantry", pantry: "garden", expeditions: "help" } as const;
    const opened = props.quickMenu === current;
    const seen = visited === current || opened;
    const contentTarget = { profile: '[data-guide-profile-tabs]',
      pantry: surface.pantryRelics ? '[data-guide-pantry-relics]' : surface.pantrySale ? '[data-guide-pantry-sale]'
        : surface.pantryItem ? '[data-guide-pantry-item]' : '[data-guide-pantry-capacity]',
      expeditions: surface.routePreparation ? '[data-route-preparation]' : surface.routeActivities
        ? '[data-section-guide-target="expedition-activities"]' : surface.routes ? '[data-section-guide-target="expedition-routes"]' : undefined };
    base.target = opened ? contentTarget[current] : `[data-world-quick="${current}"]`;
    base.primary = seen ? { advance: true, label: current === "pantry" ? "Попробуем вырастить ягоды" : "Посмотрел, дальше", onClick: () => advance(next[current]) }
      : undefined;
    if (!seen) base.summary = current === "profile" ? "Нажми на мой уровень вверху. Тут общая статистика, друзья и настройки."
      : current === "pantry" ? "Нажми «Кладовая» внизу: там хранятся припасы и можно продавать вещи."
      : "Нажми «В путь» внизу: сначала выберем занятие, затем маршрут за припасами.";
    if (opened) {
      base.hint = undefined;
      if (current === "profile") {
        base.summary = "Тут общая статистика, друзья и настройки. Переключай вкладки и осмотрись.";
        base.text = "В профиле собрана общая статистика. Во вкладке «Друзья» находятся твои люди, а шестерёнка открывает настройки. «Как Мохлик?» показывает моё состояние. Осмотрись и продолжим.";
      } else if (current === "pantry") {
        base.summary = surface.pantryRelics ? "Реликвии нужны для улучшений и обмена. Быстро продать их нельзя."
          : surface.pantrySale ? "Выбери количество и проверь итог перед кнопкой продажи."
          : surface.pantryItem ? "Нажми на предмет, чтобы посмотреть продажу. Во вкладке «Холодильник» рыба разложена по видам."
          : "Здесь будут припасы. Нажатие на обычный предмет откроет его быструю продажу.";
        base.text = surface.pantryRelics ? "Эти находки пригодятся для улучшений. Их можно обменивать с другими игроками; условия обмена показаны на рынке. Быстрой продажи торговцу для реликвий нет."
          : "Нажми на предмет и проверь количество и сумму перед продажей. В «Холодильнике» пролистывай виды рыбы по горизонтали: нажатие открывает небольшую панель, повторное добавляет одну рыбу к выбранному количеству. Припасы спишутся только по кнопке продажи. «Рынок» - отдельная торговля с игроками: можно покупать у других и выставлять свой товар, ожидая покупателя.";
        base.hint = "Продавать ради знакомства необязательно. Счётчик показывает свободное место; кнопка улучшения находится в шапке кладовой.";
      } else {
        base.summary = surface.routePreparation ? "Здесь стоимость, время и находки. Отправка начнётся только по кнопке «Отправиться»."
          : surface.routeActivities ? "Сначала выбери занятие: откроется список его маршрутов."
          : surface.routes ? "Нажми на маршрут, чтобы посмотреть стоимость, время и находки." : "Загружаем занятия и маршруты. Можно продолжить знакомство.";
        base.text = "Вылазки приносят припасы для рецептов и стройки. Сначала выбери занятие, затем маршрут: время и добычу видно до отправки. Плитка «Ускорение едой» открывает выбор блюда; еда тратится только по отдельной кнопке. Каменоломня открывается на карте и работает отдельно. Начинать вылазку ради знакомства не нужно.";
      }
    } else if (seen) {
      base.summary = "Можно открыть раздел ещё раз или продолжить знакомство.";
    }
    if (current === "pantry" && saleOwner === snapshot?.ownerPublicId) {
      base.title = "С продажей разобрались!";
      base.pose = "jump";
      base.summary = "Продажа прошла, монеты получены! Одной продажи достаточно - можно идти дальше.";
      base.text = "Ты обменял припасы на монеты у торговца. Остальное можно оставить для рецептов и стройки. Теперь посадим ягоды; в кладовую всегда можно вернуться.";
      base.hint = undefined;
      base.target = undefined;
      base.primary = { advance: true, label: "Дальше, к ягодам", onClick: () => advance("garden") };
      base.secondary = undefined;
    }
  }
  if (current === "garden") {
    base.target = surface.garden ? '[data-place="garden"] [data-recipe-product="berries"]' : undefined;
    base.text = surface.garden ? "Нажми на малину, чтобы сразу начать выращивание. Одно место даёт один предмет; его время показано в карточке. До получения готового урожая место остаётся занятым."
      : "Начнём с настоящего урожая. Я показал ягодный куст на карте. Нажми на выделенный куст, чтобы открыть его меню.";
    base.summary = surface.garden ? firstHarvest ? "Нажми на малину: первый учебный урожай созреет сразу." : "Нажми на карточку малины: она сразу начнёт расти." : "Нажми на выделенный ягодный куст на карте. Затем нажми на малину.";
    base.primary = undefined;
  }
  if (current === "grow" || reminder || harvestForOrder) {
    base.stepId = reminder ? "harvest" : harvestForOrder ? "orders-harvest" : "grow";
    base.title = harvested ? "Урожай в кладовой!" : crop ? berry?.growing ? "Ягоды уже растут" : "Пора собрать ягоды" : "Посади первые ягоды";
    base.pose = harvested ? "jump" : crop ? "present" : "wonder";
    base.summary = harvested ? "Ягоды получены в кладовую. Первый урожай твой!"
      : crop ? berry?.growing ? "Ягоды растут сами. Можно продолжать знакомство - о сборе напомню."
      : berry?.collecting ? "Сбор уже начат. Дождись, пока я отнесу урожай в кладовую."
      : `Нажми «${berry?.button ?? "Собрать"}» у ягод и дождись, пока я отнесу урожай в кладовую.`
      : recipe ? firstHarvest ? "Нажми на малину: первый урожай созреет сразу, и можно отправиться за ним." : "Нажми на карточку малины. Дождись подтверждения выращивания."
      : "Рецепты ещё загружаются. Можно отложить этот шаг.";
    base.text = harvested ? "Получение подтверждено: ягоды попали в кладовую. Ты прошёл весь путь - выбрал рецепт, вырастил и собрал урожай."
      : crop ? berry?.growing ? `Заказ появился в хозяйстве. До урожая ещё ${worldDuration(Math.max(1, Math.ceil((Date.parse(crop.finishesAt) - economy.now) / 1000)))}. Можно закрыть карту: ягоды продолжат расти.`
      : berry?.collecting ? "Я собираю урожай и несу его в кладовую. Сбор сохранён: после возвращения в игру его можно продолжить."
      : `Нажми «${berry?.button ?? "Собрать"}» у ягод. ${berry && berry.count > 1 ? "Все созревшие ягоды заберу за один подход. " : ""}Я подойду к кусту и отнесу урожай в кладовую.`
      : recipe ? firstHarvest ? "Первый учебный урожай созреет сразу. Нажми на малину, затем отправь Мохлика собрать её. Эта помощь доступна один раз на аккаунт; повтор обучения её не возвращает."
      : `Одно нажатие на малину даёт ${recipe.rewards.berries ?? 0} предмет за ${worldRecipeDuration(recipe.seconds)}. ${recipe.cost.coins === 0 && !Object.keys(recipe.cost.items).length ? "Монеты и материалы не нужны." : "Стоимость уже показана в карточке."} Нажми на карточку, когда будешь готов начать.`
      : "Сначала нужно загрузить рецепты хозяйства. Пока можно осмотреть карту или вернуться к этому шагу позже.";
    base.hint = harvested ? "Теперь так же можно создавать другие продукты и материалы."
      : crop && berry?.growing ? "После знакомства я напомню о сборе на карте, когда урожай созреет. Ждать здесь не нужно."
      : "Нажатие на предмет сразу запускает работу. Если чего-то не хватает, причина появится в карточке.";
    base.target = surface.garden ? crop ? berry?.growing || berry?.collecting ? undefined : `[data-job-id="${crop.id}"] button`
      : '[data-place="garden"] [data-recipe-product="berries"]' : undefined;
    if (harvested) {
      base.target = '[data-world-quick="pantry"]';
      base.summary = "Ягоды получены! Их можно посмотреть, нажав «Кладовая» внизу, или продолжить знакомство.";
      base.primary = { advance: true, label: reminder ? "Готово" : "Продолжить знакомство", onClick: () => { if (reminder) setHarvestOwner(null); else advance("neighbors"); } };
    } else if (crop && berry?.growing) {
      base.primary = harvestForOrder ? undefined : { advance: true, label: "Продолжить знакомство", onClick: () => advance("neighbors") };
    } else if (crop) {
      base.primary = undefined;
      if (!surface.garden && !berry?.collecting) base.summary = `Ягоды готовы. Нажми на выделенный куст на карте, затем на «${berry?.button ?? "Собрать"}» в его меню.`;
      base.status = props.isOnline === false ? "Сейчас нет связи. Сбор продолжим после подключения."
        : economy.uncertain ? "Получение урожая ещё не подтверждено. Проверим результат запроса."
        : economy.busy ? "Жду подтверждения хозяйства…" : economy.error ?? (berry?.collecting ? berry.label : berry?.awayReason ?? (snapshot && Object.values(crop.rewards).reduce((sum, amount) => sum + amount, 0) > snapshot.storage.available ? "В кладовой мало места. Освободи его и вернись к сбору." : undefined));
    } else {
      base.primary = undefined;
      if (!surface.recipe) base.summary = surface.garden ? "Нажми на малину в меню куста, чтобы сразу начать выращивание."
        : "Нажми на выделенный ягодный куст на карте, затем на карточку малины.";
      base.status = props.isOnline === false ? "Сейчас нет связи. Запустить выращивание можно после подключения." : economy.uncertain ? "Запрос ещё не подтверждён. Проверь его результат в хозяйстве." : economy.error ?? reason ?? undefined;
    }
    if (harvestForOrder) {
      base.title = crop ? berry?.growing ? "Малина для первого заказа растёт" : "Соберём малину для заказа" : "Вырастим малину для заказа";
      base.secondary = { label: "Пропустить сбор и заказ", onClick: () => advance("workshop", false) };
      base.hint = "Посадить и собрать - два разных действия. Заказ пока не выполнен: сначала урожай должен попасть в кладовую.";
      base.children = <WorkshopRetry economy={economy} isOnline={props.isOnline} />;
      if (crop && berry?.growing) {
        base.summary = "Малина ещё растёт. Когда созреет, нажми на куст, затем «Собрать». К заказу перейдём после получения урожая.";
        base.text = `До созревания ещё ${worldDuration(Math.max(1, Math.ceil((Date.parse(crop.finishesAt) - economy.now) / 1000)))}. Ягода остаётся на кусте, пока ты не начнёшь сбор. Мохлик отнесёт её в кладовую; только после подтверждения покажу сдачу заказа.`;
      }
      if (props.ordersOpen) {
        base.summary = "Для заказа нужна собранная малина. Вернись к ягодному кусту: растущий урожай ещё не находится в кладовой.";
        base.target = undefined;
        base.primary = { label: "Вернуться к кусту", onClick: props.onCloseSurface };
      }
    }
    if (reminder) {
      base.progress = undefined; base.onBack = undefined;
      base.secondary = undefined;
      base.onSkip = () => { setHarvestOwner(null); props.onCrop(undefined); };
    }
  }
  if (current === "neighbors") {
    const seen = visited === "neighbors";
    base.summary = seen ? "Здесь можно поговорить со знакомыми жителями. Новые соседи появятся позже."
      : props.quickMenu === "more" ? "Нажми «Персонажи», чтобы познакомиться с жителями, которые уже здесь."
      : "Нажми «Ещё» внизу, затем «Персонажи». Там собраны знакомые жители леса.";
    base.text = "Шишколап строит, Плёска помогает с рыбалкой, а Лопоух заготавливает древесину. Выбери знакомого соседа. Новые жители откроются по мере развития хозяйства; пока их нет, виден только силуэт.";
    base.hint = "Для знакомства не нужно ничего покупать или строить.";
    base.children = undefined;
    base.target = seen ? undefined : props.quickMenu === "more" ? '[data-world-characters-trigger]' : '[data-world-quick="more"]';
    base.primary = seen ? { advance: true, label: "Дальше, к заказам", onClick: () => advance("orders") } : undefined;
    // A resident conversation owns its own controls and focus until it closes.
    base.open = props.open && !props.modalBlocked && !props.residentOpen;
  }
  if (current === "orders" && !harvestForOrder) {
    const offline = props.isOnline === false;
    const locked = offline || economy.busy || economy.uncertain || economy.retryAt > economy.now;
    const missing = Boolean(snapshot && order && Object.entries(order.items).some(([id, count]) => (snapshot.inventory[id] ?? 0) < count));
    base.title = "Выполним учебный заказ";
    base.secondary = { label: "Этот шаг позже", onClick: () => advance("workshop", false) };
    base.hint = "Учебный заказ всего один. Следующие просьбы будут частью пути к улучшению дома.";
    base.children = <>{!lessonDone && <TutorialOrderContents economy={economy} />}<WorkshopRetry economy={economy} isOnline={props.isOnline} /></>;
    base.status = offline ? "Сейчас нет связи. Можно вернуться к заказу позже."
      : economy.uncertain ? "Результат ещё не подтверждён. Проверим его перед следующим действием."
      : economy.busy ? "Жду подтверждения хозяйства…" : economy.error ?? undefined;
    if (!props.ordersOpen && !lessonDone) {
      base.title = progress?.harvested ? "Урожай получен. Теперь выполним заказ" : "Доска заказов жителей";
      base.summary = progress?.harvested ? "Малина получена в кладовую. Нажми на выделенную доску заказов на карте, чтобы передать её Шишколапу."
        : "Нажми на выделенную доску на карте. Жители оставляют здесь просьбы и платят монеты за припасы.";
      base.text = "Доска заказов на карте открывает журнал. В нём видны нужные товары и награда: собери припасы, затем нажми «Отдать заказ». Первый учебный заказ просит одну малину из первого урожая. Дальше появятся просьбы для улучшения дома и обычные заказы жителей.";
      base.hint = "Камера показывает доску, а светлая обводка помогает найти её. Нажми на саму доску.";
      // The authored map contour is highlighted by WorldScene, just like the bush.
      // Only a real tap on the board opens the journal; no detached HUD shortcut.
      base.target = undefined;
      base.primary = undefined;
    } else if (!snapshot || !practice || !order && !lessonDone) {
      base.summary = "Загружаю учебную просьбу и её условия.";
      base.text = "Соседи платят за припасы. Проверим, сколько товаров нужно собрать для первой просьбы.";
      base.primary = { label: "Обновить хозяйство", disabled: locked, onClick: () => void economy.refresh() };
    } else if (lessonDone) {
      const confirmed = !economy.busy && !economy.uncertain;
      base.title = confirmed ? "Учебный заказ выполнен!" : "Проверяю результат заказа";
      base.pose = confirmed ? "jump" : "hold";
      base.summary = confirmed ? "Припасы переданы, награда получена. Так работают заказы соседей!"
        : "Дождёмся подтверждения, прежде чем отмечать заказ выполненным.";
      base.text = "Ты передал припасы и получил монеты. Учебный заказ завершён. Дальше в «Пути хозяйства» появятся небольшие просьбы для улучшения дома. «Просьбы жителей» можно выполнять ради дополнительного заработка. Недостающий товар подскажет, где его взять.";
      base.hint = "Дальше заглянем в мастерскую. К заказам можно вернуться в любое время.";
      base.primary = { advance: true, label: "К мастерской", disabled: !confirmed, onClick: () => advance("workshop") };
      base.secondary = undefined;
    } else if (!practice.ingredientsClaimed) {
      base.summary = `Откроем сохранённую учебную просьбу с наградой ${order!.coins} монет.`;
      base.text = "Нажми «Открыть учебный заказ». Товары для него нужно собрать или приготовить самому: они не выдаются бесплатно.";
      base.primary = { label: "Открыть учебный заказ", disabled: locked, onClick: () => { if (!locked) pinOrder(); } };
    } else {
      const firstHarvest = order?.items.berries === 1 && Object.keys(order.items).length === 1;
      base.summary = props.ordersOpen ? surface.tutorialOrder
        ? missing ? "Сравни «есть / нужно». Собери недостающие припасы, затем нажми «Отдать заказ»." : firstHarvest ? "Малина в кладовой. Нажми «Отдать заказ»: спишется одна малина, а ты получишь монеты." : "Припасы в кладовой. Сравни «есть / нужно» и нажми «Отдать заказ», чтобы передать их за награду."
        : "Нажми фильтр «Все»: над обычными просьбами появится учебный заказ."
        : "Нажми на выделенную доску заказов на карте: откроется журнал просьб соседей.";
      base.text = `Доска заказов на карте открывает журнал. Учебный заказ находится в «Пути хозяйства», в фильтре «Все». ${firstHarvest ? progress?.harvested ? "Сбор урожая подтверждён. Сдача заказа - отдельное действие: одна малина спишется из кладовой, а награда поступит в кошелёк." : "Нужна одна малина: забери первый урожай с куста." : "Состав сохранённого заказа указан в карточке: собери недостающие припасы."} Затем нажми «Отдать заказ».`;
      base.target = props.ordersOpen ? surface.tutorialOrder && order ? `[data-order-id="${order.id}"] [data-guide-order-submit]` : '[data-order-filter="all"]'
        : undefined;
      base.primary = undefined;
      base.status ??= missing ? "Припасов пока не хватает. Нажми недостающий товар на доске, чтобы найти его источник." : undefined;
    }
  }
  if (current === "workshop") {
    const building = snapshot?.catalog.buildings.find(item => item.id === "workshop");
    const level = snapshot?.buildings.workshop ?? 0;
    const construction = snapshot?.jobs.find(job => job.kind === "construction" && job.targetId === "workshop");
    const first = building?.levels.find(item => item.level === 1);
    const next = building?.levels.find(item => item.level === level + 1);
    const offline = props.isOnline === false;
    const locked = offline || economy.busy || economy.uncertain || economy.retryAt > economy.now;
    const tutorialWorkshop = Boolean(snapshot && canStartTutorialWorkshop(snapshot));
    const constructionReason = snapshot && next && !tutorialWorkshop ? worldConstructionReason(snapshot, "workshop", next) : undefined;
    base.hint = tutorialWorkshop ? "Учебный набор идёт прямо в мастерскую и не тратит твои запасы. Стройка начнётся только по твоему нажатию."
      : "Стройка оплачивается твоими запасами и запускается по твоему нажатию. Ждать здесь не нужно.";
    base.secondary = { label: "Этот шаг позже", onClick: () => advance("expeditions", false) };
    base.target = undefined;
    base.children = <>{level === 0 && !construction && <WorkshopConstructionContents economy={economy} />}<WorkshopRetry economy={economy} isOnline={props.isOnline} /></>;
    base.status = offline ? "Сейчас нет связи. Можно продолжить знакомство и вернуться позже."
      : economy.uncertain ? "Ответ ещё не подтверждён. Проверим результат прежде, чем продолжить."
      : economy.busy ? "Жду подтверждения хозяйства…" : economy.error ?? undefined;
    if (!snapshot || !first) {
      base.title = "Мастерская для новых идей";
      base.summary = "Мастерская создаёт материалы для построек. Подождём загрузки хозяйства.";
      base.text = "Здесь бревно превращается в доску. Загружаю хозяйство, чтобы показать следующий шаг.";
      base.primary = { label: "Обновить хозяйство", onClick: () => void economy.refresh(), disabled: locked };
    } else if (construction) {
      const confirmed = !economy.busy && !economy.uncertain;
      const remaining = Math.max(0, Math.ceil((Date.parse(construction.finishesAt) - economy.now) / 1000));
      base.title = confirmed ? remaining ? "Шишколап уже строит!" : "Мастерская почти готова" : "Проверяю начало стройки";
      base.summary = confirmed ? remaining ? "Стройка началась. Можно идти дальше, ждать у здания не нужно." : "Открой мастерскую и заверши строительство."
        : "Дождёмся подтверждения, прежде чем отмечать начало стройки.";
      base.pose = confirmed ? "jump" : "hold";
      base.text = !confirmed ? "Проверяем ответ хозяйства. После подтверждения покажем срок стройки; повторно нажимать строительство не нужно."
        : remaining ? `Заказ принят. До готовности ещё ${worldDuration(remaining)}. Другие производства продолжают работать.`
        : "Время стройки закончилось. Открой мастерскую и заверши строительство; дальше появится рецепт доски.";
      base.primary = { advance: true, label: "Продолжить знакомство", disabled: !confirmed, onClick: () => { if (confirmed) advance("expeditions"); } };
      base.secondary = undefined;
    } else if (level > 0) {
      base.title = "Мастерская уже есть";
      base.summary = props.workshopOpen ? surface.workshopSelected ? "Карточка доски сразу запускает работу: одно бревно превращается в одну доску за две минуты."
        : "Выбери вкладку «Мастерская» в шапке: там находится рецепт доски."
        : "Нажми на выделенную мастерскую на карте. В её меню находятся рецепты и улучшение.";
      base.pose = "present";
      base.text = `У тебя мастерская ${level}-го уровня. Доски нужны для просьб хозяйства и улучшения дома. Загляни в рецепт: материалы, время и результат видны до запуска.`;
      base.hint = "Первое место производства бесплатное. Готовую доску нужно забрать перед следующим запуском. У мастерской и печи отдельные очереди.";
      base.target = props.workshopOpen ? surface.workshopSelected ? '[data-place="workshop"] [data-recipe-product="planks"]'
        : '[data-place="workshop"] [role="tab"][id$="-workshop"]' : undefined;
      base.primary = visited === "workshop" ? { advance: true, label: "Дальше, к вылазкам", onClick: () => advance("expeditions") } : undefined;
    } else if (tutorialWorkshop) {
      base.title = "Построим мастерскую с Шишколапом";
      base.summary = props.workshopOpen ? surface.workshopSelected
        ? "Нажми «Построить с учебным набором». Шишколап даст всё необходимое прямо на эту стройку."
        : "Выбери вкладку «Мастерская» в шапке: там сможем начать стройку с учебным набором."
        : "Нажми на выделенную мастерскую на карте. Шишколап приготовил для неё учебный набор.";
      base.pose = "present";
      base.text = `Шишколап один раз даст все монеты и материалы для первой мастерской. Набор используется прямо в стройке: твои запасы не расходуются, даже если раньше ты потратил их на другое здание. Стройка занимает ${worldDuration(first.seconds)}. Нажми «Построить с учебным набором», когда будешь готов.`;
      base.target = props.workshopOpen ? surface.workshopSelected ? undefined
        : '[data-place="workshop"] [role="tab"][id$="-workshop"]' : undefined;
      base.children = <><WorkshopConstructionContents economy={economy} /><WorkshopRetry economy={economy} isOnline={props.isOnline} /></>;
      base.primary = props.workshopOpen && surface.workshopSelected ? tutorialWorkshopAction(economy, props.isOnline) : undefined;
      base.status ??= snapshot.jobs.some(job => job.kind === "construction") ? "Шишколап сейчас строит другое здание. Дождись завершения, затем начни мастерскую с учебным набором." : undefined;
    } else {
      base.title = "Построим мастерскую";
      base.summary = props.workshopOpen ? surface.workshopSelected ? "Нажми «Построить» в шапке меню. В плане проверь стоимость и начни стройку."
        : "Выбери вкладку «Мастерская» в шапке, затем нажми «Построить», чтобы посмотреть план стройки."
        : "Нажми на выделенную мастерскую на карте, чтобы открыть её план.";
      base.pose = "present";
      base.text = `Сначала обустрой лесной участок и костёр, выполни первые просьбы соседей. Накопленных монет и материалов хватит на мастерскую. Стройка занимает ${worldDuration(first.seconds)}.`;
      base.target = props.workshopOpen ? surface.workshopSelected ? '[data-guide-station-upgrade="workshop"]'
        : '[data-place="workshop"] [role="tab"][id$="-workshop"]' : undefined;
      base.primary = undefined;
      base.status ??= constructionReason ?? undefined;
    }
  }
  if (current === "help") {
    const fullCourse = WORLD_ONBOARDING_STEPS.every(item => item.id === "help" || progress?.completedSteps?.includes(item.id));
    const construction = snapshot?.jobs.find(job => job.kind === "construction" && job.targetId === "workshop");
    const workshopLevel = snapshot?.buildings.workshop ?? 0;
    const cropResult = tracked ? cropReady ? "Ягоды готовы к сбору." : "Ягоды растут."
      : harvested ? "Первый урожай уже в кладовой." : "Ягоды можно посадить в любое время.";
    const workshopResult = !snapshot ? "Хозяйство ещё загружается." : construction ? economy.now >= Date.parse(construction.finishesAt)
      ? "Время стройки мастерской закончилось - проверь результат." : workshopLevel > 0 ? "Мастерская улучшается." : "Мастерская строится."
      : workshopLevel > 0 ? `Мастерская работает: уровень ${workshopLevel}.`
      : canStartTutorialWorkshop(snapshot) ? "Для первой мастерской Шишколап приготовил учебный набор. Его можно использовать в шаге обучения мастерской."
      : "Мастерскую можно построить за монеты и материалы, заработанные на первых просьбах.";
    base.target = '[data-world-onboarding-help]';
    base.summary = "Кнопка i вверху открывает справку: выбери тему или воспользуйся поиском. Подсказки раздела запускаются по «Что здесь делать?».";
    base.text = `${cropResult} ${workshopResult} Кнопка i открывает темы и поиск по справке. Для повтора открой мой профиль, нажми «?» рядом с шестерёнкой, затем «Повторить обучение». Если знакомство ещё идёт, там будет «Продолжить обучение».`;
    base.hint = fullCourse ? `Заверши обучение и получи ${completionGift}. Подарок выдаётся один раз на аккаунт.`
      : `Некоторые шаги отложены. Когда пройдёшь весь курс, получишь ${completionGift}. Повтор доступен в профиле.`;
    if (!fullCourse) base.summary = `Некоторые шаги отложены. Их можно пройти позже и получить ${completionGift}. Справка всегда под кнопкой i.`;
    base.pose = "greet";
    base.primary = { advance: true, label: "Завершить обучение", shortLabel: "Готово", onClick: finish };
    base.secondary = undefined;
  }
  if (props.fishSaleOpen) base.open = false;
  return <GuideCoach {...base} />;
}
