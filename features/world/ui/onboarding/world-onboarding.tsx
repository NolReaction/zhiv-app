"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { GuideCoach, type GuideCoachProps } from "@/features/onboarding/guide-coach";
import { WORLD_ONBOARDING_STEPS, type WorldOnboardingProgress, type WorldOnboardingStepId } from "@/features/world/domain/world-onboarding";
import { useForestObservation } from "@/features/world/state/use-forest-observation";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { isBerryProduction, berryCollectionStatus } from "@/features/economy/integration/garden-collection";
import { useGardenCollection } from "@/features/economy/integration/garden-collection-context";
import { TUTORIAL_ORDER_ID, tutorialOrderProgress, tutorialResidentOrder } from "@/features/economy/domain/tutorial-order";
import { worldConstructionReason, worldDuration, worldProductionReason } from "@/features/economy/ui/shared/world-stations";
import { TutorialOrderContents, WorkshopRetry, WorkshopConstructionContents } from "./world-onboarding-cards";

export type WorldOnboardingProps = {
  open: boolean;
  modalBlocked: boolean;
  progress: WorldOnboardingProgress | null;
  worldElement: RefObject<HTMLElement | null>;
  economy: EconomyController;
  quickMenu: string | null;
  helpOpen: boolean;
  residentOpen: string | null;
  charactersOpen?: boolean;
  ordersOpen: boolean;
  workshopOpen: boolean;
  isOnline?: boolean;
  onStart: () => void;
  onStep: (stepId: WorldOnboardingStepId) => void;
  onCrop: (jobId: string | undefined) => void;
  onSkip: () => void;
  onComplete: () => void;
  onPause: () => void;
  onCloseSurface: () => void;
};

/** Track actual opened content, including choices made outside the coach. */
function usePracticeSurface(root: RefObject<HTMLElement | null>) {
  const [surface, setSurface] = useState({ garden: false, recipe: false, pantryItem: false, pantrySale: false, pantryRelics: false, routePreparation: false, tutorialOrder: false });
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
        tutorialOrder: Boolean(element.querySelector('[data-tutorial-order="true"]')),
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
  const [saleOwner, setSaleOwner] = useState<string | null>(null);
  const previousSale = useRef({ owner: economy.snapshot?.ownerPublicId, step: current,
    id: economy.localSale?.id, revision: economy.snapshot?.revision ?? -1 });
  const previous = useRef<{ jobId?: string; revision: number; gainIds: Set<string> }>({ revision: -1, gainIds: new Set() });
  const orderPinSent = useRef(false);
  const snapshot = economy.snapshot;
  const tracked = snapshot?.jobs.find(job => job.id === progress?.cropJobId && isBerryProduction(job));
  const existing = snapshot?.jobs.filter(isBerryProduction).sort((a, b) => Date.parse(a.finishesAt) - Date.parse(b.finishesAt))[0];
  const crop = tracked ?? (current === "grow" ? existing : undefined);
  const berry = crop && snapshot ? berryCollectionStatus(crop, snapshot, economy.now, collection) : null;
  const recipe = snapshot?.catalog.recipes.find(item => item.id === "grow_berries");
  const reason = recipe && snapshot ? worldProductionReason(snapshot, recipe, 1) : null;
  const cropReady = Boolean(tracked && economy.now >= Date.parse(tracked.finishesAt));
  const reminder = progress?.status === "completed" && (cropReady || harvested);
  const advance = (next: WorldOnboardingStepId) => { props.onCloseSurface(); setVisited(null); setSaleOwner(null); props.onStep(next); };
  const finish = () => { setHarvested(false); props.onCloseSurface(); props.onComplete(); };
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
    title: "Привет! Это наш лес", text: "Я Мохлик. За 3-5 минут посадим ягоды, познакомимся с соседями и заглянем в мастерскую. Всё можно открывать и пробовать.",
    summary: "Посадим ягоды и познакомимся с лесом за несколько минут.",
    hint: "Ждать урожай и стройку не придётся. Любой шаг можно отложить. Когда объяснение закончено, нажми на меня или на реплику.",
    pose: "greet", welcome: !progress, targetRoot: worldElement,
    compact: Boolean(props.quickMenu || surface.garden || props.workshopOpen),
    dock: props.quickMenu ? "#world-quick-menu [data-guide-coach-slot]" : surface.garden || props.workshopOpen ? "[data-place] [data-guide-coach-slot]" : undefined,
    onPause: props.onPause, onSkip: props.onSkip,
    primary: { label: "Давай попробуем", onClick: props.onStart },
  };
  if (step) {
    base.title = step.title; base.summary = step.summary; base.text = step.text; base.hint = step.hint; base.pose = step.pose;
    base.progress = { current: index + 1, total: WORLD_ONBOARDING_STEPS.length };
    base.primary = undefined;
    base.onBack = index > 0 ? () => advance(WORLD_ONBOARDING_STEPS[index - 1].id) : undefined;
    base.secondary = { label: "Этот шаг позже", onClick: index < WORLD_ONBOARDING_STEPS.length - 1 ? () => advance(WORLD_ONBOARDING_STEPS[index + 1].id) : finish };
  }
  if (current === "profile" || current === "pantry" || current === "expeditions") {
    const next = { profile: "pantry", pantry: "garden", expeditions: "help" } as const;
    const opened = props.quickMenu === current;
    const seen = visited === current || opened;
    const contentTarget = { profile: '[data-guide-profile-tabs]',
      pantry: surface.pantryRelics ? '[data-guide-pantry-relics]' : surface.pantrySale ? '[data-guide-pantry-sale]'
        : surface.pantryItem ? '[data-guide-pantry-item]' : '[data-guide-pantry-capacity]',
      expeditions: '[data-route]' };
    base.target = opened ? contentTarget[current] : `[data-world-quick="${current}"]`;
    base.primary = seen ? { advance: true, label: current === "pantry" ? "Попробуем вырастить ягоды" : "Посмотрел, дальше", onClick: () => advance(next[current]) }
      : undefined;
    if (!seen) base.summary = current === "profile" ? "Нажми на мой уровень вверху. Тут общая статистика, друзья и настройки."
      : current === "pantry" ? "Нажми «Кладовая» внизу: там хранятся припасы и можно продавать вещи."
      : "Нажми «В путь» внизу: там маршруты за материалами и находками.";
    if (opened) {
      base.hint = undefined;
      if (current === "profile") {
        base.summary = "Тут общая статистика, друзья и настройки. Переключай вкладки и осмотрись.";
        base.text = "В профиле собрана общая статистика. Во вкладке «Друзья» находятся твои люди, а шестерёнка открывает настройки. «Как Мохлик?» показывает моё состояние. Осмотрись и продолжим.";
      } else if (current === "pantry") {
        base.summary = surface.pantryRelics ? "Реликвии нужны для улучшений и обмена. Быстро продать их нельзя."
          : surface.pantrySale ? "Если предмет можно продать, выбери количество и проверь итог перед «Продать торговцу»."
          : surface.pantryItem ? "Нажми на предмет: там условия быстрой продажи за монеты. Сейчас можно только посмотреть."
          : "Здесь будут припасы. Нажатие на обычный предмет откроет его быструю продажу.";
        base.text = surface.pantryRelics ? "Эти находки пригодятся для улучшений. Их можно обменивать с другими игроками; условия обмена показаны на рынке. Быстрой продажи торговцу для реликвий нет."
          : "Нажми на обычный предмет, выбери количество и проверь сумму перед кнопкой «Продать торговцу». Некоторые предметы не продаются, а для других нужно набрать минимальное количество - условия будут рядом. «Рынок» - отдельная торговля с игроками: можно покупать у других и выставлять свой товар, ожидая покупателя.";
        base.hint = "Продавать ради знакомства необязательно. Счётчик места показывает, сколько ещё поместится в кладовой.";
      } else {
        base.summary = surface.routePreparation ? "Здесь стоимость, время и находки. Отправка начнётся только по кнопке «Отправиться»."
          : "Нажми на маршрут, чтобы посмотреть стоимость, время и находки.";
        base.text = "Вылазки приносят припасы для рецептов и стройки. Выбери карточку маршрута и посмотри подготовку: стоимость, время и добычу видно до отправки. Начинать вылазку ради знакомства не нужно.";
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
    base.target = surface.garden ? '[data-recipe="grow_berries"]' : undefined;
    base.text = surface.garden ? "Выбери малину. Одно место выращивает один предмет за минуту. До получения готового урожая место остаётся занятым."
      : "Начнём с настоящего урожая. Я показал ягодный куст на карте. Нажми на выделенный куст, чтобы открыть его меню.";
    base.summary = surface.garden ? "Нажми на малину: откроется рецепт с временем и наградой." : "Нажми на выделенный ягодный куст на карте. Затем выбери малину.";
    base.primary = undefined;
  }
  if (current === "grow" || reminder) {
    base.stepId = reminder ? "harvest" : "grow";
    base.title = harvested ? "Урожай в кладовой!" : crop ? berry?.growing ? "Ягоды уже растут" : "Пора собрать ягоды" : "Посади первые ягоды";
    base.pose = harvested ? "jump" : crop ? "present" : "wonder";
    base.summary = harvested ? "Ягоды получены в кладовую. Первый урожай твой!"
      : crop ? berry?.growing ? "Ягоды растут сами. Можно продолжать знакомство - о сборе напомню."
      : "Нажми «Собрать» у ягод и дождись, пока я отнесу урожай в кладовую."
      : recipe ? "Нажми «Начать» в карточке ягод. Дождись подтверждения выращивания."
      : "Рецепты ещё загружаются. Можно отложить этот шаг.";
    base.text = harvested ? "Получение подтверждено: ягоды попали в кладовую. Ты прошёл весь путь - выбрал рецепт, вырастил и собрал урожай."
      : crop ? berry?.growing ? `Заказ появился в хозяйстве. До урожая ещё ${worldDuration(Math.max(1, Math.ceil((Date.parse(crop.finishesAt) - economy.now) / 1000)))}. Можно закрыть карту: ягоды продолжат расти.`
      : "Нажми «Собрать» у ягод. Я подойду к кусту, соберу урожай и отнесу его в кладовую. Если сбор уже начат, дай мне закончить."
      : recipe ? `Один запуск даёт ${recipe.rewards.berries ?? 0} предмет за ${worldDuration(recipe.seconds)}. ${recipe.cost.coins === 0 && !Object.keys(recipe.cost.items).length ? "Монеты и материалы не нужны." : "Перед запуском проверь стоимость в рецепте."} Нажми настоящую кнопку «Начать» в карточке.`
      : "Сначала нужно загрузить рецепты хозяйства. Пока можно осмотреть карту или вернуться к этому шагу позже.";
    base.hint = harvested ? "Теперь так же можно создавать другие продукты и материалы."
      : crop && berry?.growing ? "После знакомства я напомню о сборе на карте, когда урожай созреет. Ждать здесь не нужно."
      : "Кнопка в карточке работает как обычно. Если не хватает места или Мохлик занят, причина показана рядом.";
    base.target = surface.garden ? crop ? berry?.growing ? undefined : `[data-job-id="${crop.id}"] button`
      : surface.recipe ? '[data-recipe-preparation="grow_berries"] [data-recipe-order] > button' : '[data-recipe="grow_berries"]' : undefined;
    if (harvested) {
      base.target = '[data-world-quick="pantry"]';
      base.summary = "Ягоды получены! Их можно посмотреть, нажав «Кладовая» внизу, или продолжить знакомство.";
      base.primary = { advance: true, label: reminder ? "Готово" : "Продолжить знакомство", onClick: () => { if (reminder) setHarvested(false); else advance("neighbors"); } };
    } else if (crop && berry?.growing) {
      base.primary = { advance: true, label: "Продолжить знакомство", onClick: () => advance("neighbors") };
    } else if (crop) {
      base.primary = undefined;
      if (!surface.garden) base.summary = "Ягоды готовы. Нажми на выделенный куст на карте, затем на «Собрать» в его меню.";
      base.status = berry?.collecting ? berry.label : berry?.awayReason ?? (snapshot && Object.values(crop.rewards).reduce((sum, amount) => sum + amount, 0) > snapshot.storage.available ? "В кладовой мало места. Освободи его и вернись к сбору." : undefined);
    } else {
      base.primary = undefined;
      if (!surface.recipe) base.summary = surface.garden ? "Выбери малину в меню куста. Затем нажми «Начать» в рецепте."
        : "Нажми на выделенный ягодный куст на карте, выбери малину и открой рецепт.";
      base.status = props.isOnline === false ? "Сейчас нет связи. Запустить выращивание можно после подключения." : economy.uncertain ? "Запрос ещё не подтверждён. Проверь его результат в хозяйстве." : economy.error ?? reason ?? undefined;
    }
    if (reminder) {
      base.progress = undefined; base.onBack = undefined;
      base.secondary = undefined;
      base.onSkip = () => { setHarvested(false); props.onCrop(undefined); };
    }
  }
  if (current === "neighbors") {
    const seen = visited === "neighbors";
    base.summary = seen ? "Плёска помогает с рыбалкой, Шишколап - со стройкой. Теперь ты знаешь, где найти соседей."
      : props.quickMenu === "more" ? "Нажми «Персонажи» в меню «Ещё». В списке можно выбрать Плёску или Шишколапа."
      : "Плёска помогает с рыбалкой, Шишколап - со стройкой. Нажми «Ещё» внизу, чтобы найти соседей.";
    base.text = "Обычный путь к жителям: «Ещё», затем «Персонажи». В списке нажми на Плёску или Шишколапа, чтобы открыть разговор. Покупать ничего не нужно.";
    base.hint = "Соседи также доступны при нажатии на их домики на карте.";
    base.target = seen ? undefined : props.quickMenu === "more" ? '[data-world-characters-trigger]' : '[data-world-quick="more"]';
    base.primary = seen ? { advance: true, label: "Дальше, к заказам", onClick: () => advance("orders") } : undefined;
    // A resident conversation owns its own controls and focus until it closes.
    base.open = props.open && !props.modalBlocked && !props.residentOpen;
  }
  if (current === "orders") {
    const order = snapshot ? tutorialResidentOrder(snapshot) : null;
    const practice = snapshot ? tutorialOrderProgress(snapshot) : null;
    const offline = props.isOnline === false;
    const locked = offline || economy.busy || economy.uncertain || economy.retryAt > economy.now;
    const missing = Boolean(snapshot && order && Object.entries(order.items).some(([id, count]) => (snapshot.inventory[id] ?? 0) < count));
    const lessonDone = Boolean(practice && (practice.completed || practice.version === 2 && practice.step > 0));
    base.title = "Выполним учебный заказ";
    base.secondary = { label: "Этот шаг позже", onClick: () => advance("workshop") };
    base.hint = "Собирай и готовь припасы сам. Учебные просьбы не исчезнут после паузы.";
    base.children = <>{!lessonDone && <TutorialOrderContents economy={economy} />}<WorkshopRetry economy={economy} isOnline={props.isOnline} /></>;
    base.status = offline ? "Сейчас нет связи. Можно вернуться к заказу позже."
      : economy.uncertain ? "Результат ещё не подтверждён. Проверим его перед следующим действием."
      : economy.busy ? "Жду подтверждения хозяйства…" : economy.error ?? undefined;
    if (!snapshot || !practice || !order && !practice.completed) {
      base.summary = "Загружаю учебную просьбу и её условия.";
      base.text = "Соседи платят за припасы. Проверим, сколько товаров нужно собрать для первой просьбы.";
      base.primary = { label: "Обновить хозяйство", disabled: locked, onClick: () => void economy.refresh() };
    } else if (lessonDone) {
      const confirmed = !economy.busy && !economy.uncertain;
      base.title = confirmed ? "Учебный заказ выполнен!" : "Проверяю результат заказа";
      base.pose = confirmed ? "jump" : "hold";
      base.summary = confirmed ? practice.version === 2 && !practice.completed
        ? `Выполнено учебных просьб: ${practice.step} / 4. Следующая уже на доске. Можно продолжать знакомство!`
        : "Припасы переданы, награда получена. Так работают заказы соседей!"
        : "Дождёмся подтверждения, прежде чем отмечать заказ выполненным.";
      base.text = practice.version === 2 ? "Продолжай выполнять просьбы по очереди: два бревна, два компота и две доски. Они помогут обустроить лесной участок, костёр и мастерскую. Все четыре нужны для улучшения дома. Недостающий товар можно нажать на доске, чтобы узнать, где его взять."
        : "Ты передал припасы соседу и получил монеты. У обычных заказов так же: сравни «есть / нужно», проверь награду и нажми «Отдать заказ».";
      base.hint = "Дальше заглянем в мастерскую. К заказам можно вернуться в любое время.";
      base.primary = { advance: true, label: "К мастерской", disabled: !confirmed, onClick: () => advance("workshop") };
      base.secondary = undefined;
    } else if (!practice.ingredientsClaimed) {
      base.summary = `Откроем сохранённую учебную просьбу с наградой ${order!.coins} монет.`;
      base.text = "Нажми «Открыть учебный заказ». Товары для него нужно собрать или приготовить самому: они не выдаются бесплатно.";
      base.primary = { label: "Открыть учебный заказ", disabled: locked, onClick: () => { if (!locked) pinOrder(); } };
    } else {
      base.summary = props.ordersOpen ? surface.tutorialOrder
        ? "Сравни «есть / нужно». Собери недостающие припасы, затем нажми «Отдать заказ»."
        : "Нажми фильтр «Все»: над обычными просьбами появится учебный заказ."
        : props.quickMenu === "food" ? "Теперь нажми вкладку «Заказы» сверху. Там соседи оставляют просьбы за монеты."
        : props.quickMenu === "more" ? "В меню «Ещё» нажми «Еда и заказы». Дальше покажу просьбы соседей."
        : "Нажми «Ещё» внизу: через это меню будем находить заказы.";
      base.text = "Путь к заказам: «Ещё», затем «Еда и заказы», затем «Заказы». Учебная просьба стоит первой в фильтре «Все». Первый заказ требует две малины: вырасти и забери их с куста отдельными запусками. Затем нажми «Отдать заказ».";
      base.target = props.ordersOpen ? surface.tutorialOrder && order ? `[data-order-id="${order.id}"]` : '[data-order-filter="all"]'
        : props.quickMenu === "food" ? '[data-world-food-tab="orders"]'
        : props.quickMenu === "more" ? '[data-world-food-entry]' : '[data-world-quick="more"]';
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
    const constructionReason = snapshot && next ? worldConstructionReason(snapshot, "workshop", next) : undefined;
    base.hint = "Стройка оплачивается твоими запасами и запускается по твоему нажатию. Ждать здесь не нужно.";
    base.secondary = { label: "К вылазкам", onClick: () => advance("expeditions") };
    base.target = undefined;
    base.children = <>{level === 0 && <WorkshopConstructionContents economy={economy} />}<WorkshopRetry economy={economy} isOnline={props.isOnline} /></>;
    base.status = offline ? "Сейчас нет связи. Можно продолжить знакомство и вернуться позже."
      : economy.uncertain ? "Ответ ещё не подтверждён. Проверим результат прежде, чем продолжить."
      : economy.busy ? "Жду подтверждения хозяйства…" : economy.error ?? undefined;
    if (!snapshot || !first) {
      base.title = "Мастерская для новых идей";
      base.summary = "Мастерская создаёт материалы для построек. Подождём загрузки хозяйства.";
      base.text = "Здесь бревно превращается в доску. Загружаю хозяйство, чтобы показать следующий шаг.";
      base.primary = { label: "Обновить хозяйство", onClick: () => void economy.refresh(), disabled: locked };
    } else if (construction) {
      const remaining = Math.max(0, Math.ceil((Date.parse(construction.finishesAt) - economy.now) / 1000));
      base.title = remaining ? "Шишколап уже строит!" : "Мастерская почти готова";
      base.summary = remaining ? "Стройка началась. Можно идти дальше, ждать у здания не нужно." : "Открой мастерскую и заверши строительство.";
      base.pose = "jump";
      base.text = remaining ? `Заказ принят. До готовности ещё ${worldDuration(remaining)}. Другие производства продолжают работать.`
        : "Время стройки закончилось. Открой мастерскую и заверши строительство; дальше появится рецепт доски.";
      base.primary = { advance: true, label: "Продолжить знакомство", onClick: () => advance("expeditions") };
      base.secondary = undefined;
    } else if (level > 0) {
      base.title = "Мастерская уже есть";
      base.summary = props.workshopOpen ? "Выбери доску: одно бревно превращается в одну доску за две минуты."
        : "Нажми на выделенную мастерскую на карте. В её меню находятся рецепты и улучшение.";
      base.pose = "present";
      base.text = `У тебя мастерская ${level}-го уровня. Доски нужны для учебного заказа и улучшения дома. Загляни в рецепт: материалы, время и результат видны до запуска.`;
      base.hint = "Первое место производства бесплатное. Готовую доску нужно забрать перед следующим запуском.";
      base.target = props.workshopOpen ? '[data-section-guide-target="workshop-recipes"]' : undefined;
      base.primary = visited === "workshop" ? { advance: true, label: "Дальше, к вылазкам", onClick: () => advance("expeditions") } : undefined;
    } else {
      base.title = "Построим мастерскую";
      base.summary = props.workshopOpen ? "Нажми «Обустроить» внизу меню. В плане проверь стоимость и начни стройку."
        : "Нажми на выделенную мастерскую на карте, чтобы открыть её план.";
      base.pose = "present";
      base.text = `Сначала обустрой лесной участок и костёр, выполни первые просьбы соседей. Накопленных монет и материалов хватит на мастерскую. Стройка занимает ${worldDuration(first.seconds)}.`;
      base.target = props.workshopOpen ? '[data-guide-station-upgrade="workshop"]' : undefined;
      base.primary = undefined;
      base.status ??= constructionReason ?? undefined;
    }
  }
  if (current === "help") {
    const construction = snapshot?.jobs.find(job => job.kind === "construction" && job.targetId === "workshop");
    const workshopLevel = snapshot?.buildings.workshop ?? 0;
    const cropResult = tracked ? cropReady ? "Ягоды готовы к сбору." : "Ягоды растут."
      : harvested ? "Первый урожай уже в кладовой." : "Ягоды можно посадить в любое время.";
    const workshopResult = !snapshot ? "Хозяйство ещё загружается." : construction ? economy.now >= Date.parse(construction.finishesAt)
      ? "Время стройки мастерской закончилось - проверь результат." : workshopLevel > 0 ? "Мастерская улучшается." : "Мастерская строится."
      : workshopLevel > 0 ? `Мастерская работает: уровень ${workshopLevel}.`
      : "Мастерскую можно построить за монеты и материалы, заработанные на первых просьбах.";
    base.target = '[data-world-onboarding-help]';
    base.summary = "Кнопка i вверху открывает справку: выбери тему или воспользуйся поиском. Повторить обучение можно по «?» рядом с шестерёнкой в моём профиле.";
    base.text = `${cropResult} ${workshopResult} Кнопка i открывает темы и поиск по справке, а «?» рядом с шестерёнкой в моём профиле возвращает знакомство с лесом.`;
    base.hint = "В новых разделах я коротко объясню местные действия. Выращивание и стройка продолжаются в фоне.";
    base.pose = "greet";
    base.primary = { advance: true, label: "Готово, буду играть", onClick: finish };
    base.secondary = undefined;
  }
  return <GuideCoach {...base} />;
}
