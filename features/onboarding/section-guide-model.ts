import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import type { NavigableGuideSection } from "./section-guide-navigation";

export const sectionGuideIds = ["pantry", "market", "plesk", "orders", "meals", "expeditions", "workshop", "builder"] as const;
export type SectionGuideId = typeof sectionGuideIds[number];
export type SectionGuideStep = {
  id: string; title: string; summary: string; text: string; pose: PixelPose;
  /** First mounted, visible candidate wins; later candidates are navigation controls. */
  targets: readonly string[];
  navigation?: NavigableGuideSection;
  /** Automatically reveal a read-only explanation while its lesson is open. */
  revealOnOpen?: boolean;
  showLabel?: string;
};
export type SectionGuideProgress = {
  version: 1;
  status: "started" | "paused" | "completed" | "skipped";
  stepId: string;
};
const target = (name: string) => `[data-section-guide-target="${name}"]`;

/** Explanations contain no commands or fixed prices; actual prices stay in the game controls. */
export const sectionGuideLessons: Record<SectionGuideId, readonly SectionGuideStep[]> = {
  pantry: [
    { id: "items", title: "Запасы можно продать", pose: "present", targets: ["[data-guide-pantry-item]"],
      summary: "Нажми на предмет в кладовой - увидишь запас и условия продажи торговцу.",
      text: "Здесь лежат урожай, материалы и находки. Нажми на предмет: если его можно продать, карточка покажет количество для продажи и итоговую сумму. Если кладовая пуста, вернись сюда после урожая или вылазки." },
    { id: "sale", title: "Монеты за лишние запасы", pose: "hold", targets: ["[data-guide-pantry-sale]", "[data-guide-pantry-item]"],
      summary: "Открой предмет, выбери количество и проверь сумму. «Продать торговцу» сразу обменяет вещи на монеты.",
      text: "Быстрая продажа помогает освободить кладовую. Её цена указана в карточке; не продавай материалы, которые ещё нужны для стройки или заказа. Рыбу можно отнести Плёске - у неё свой приём улова. Продавать ради знакомства не обязательно." },
    { id: "market", title: "А где рынок?", pose: "reach", targets: ["[data-guide-pantry-market]"],
      summary: "На рынке продают другим игрокам по своей цене. Монеты приходят после покупки лота.",
      text: "Кладовая предлагает быструю продажу торговцу, а рынок - прилавок для других игроков. Там можно купить недостающие товары или выставить свои. Если рынок ещё закрыт, его условия открытия показаны у входа. Выставленные вещи продолжают занимать место до продажи." },
  ],
  market: [
    { id: "buy", title: "Рынок - лавки игроков", pose: "greet", targets: ["[data-market-offer]", '[data-guide-market-tab="buy"]'],
      summary: "Здесь покупают товары у других игроков. Цена в карточке указана за весь лот.",
      text: "Лот - это партия товара целиком. Сравни количество и полную цену перед покупкой; для вещей понадобится место в кладовой. Если рынок ещё закрыт, сначала выполни условия, указанные в этом окне." },
    { id: "sell", title: "Свой прилавок", pose: "present", targets: ["[data-guide-market-create]", '[data-guide-market-tab="sell"]'],
      summary: "Открой «Продать»: выбери товар, количество и цену всей партии.",
      text: "Форма покажет допустимую цену и сколько монет останется после сбора. Когда другой игрок купит лот, монеты поступят тебе. Само выставление не освобождает кладовую: вещи занимают место до продажи. Быстро продать торговцу можно в кладовой." },
    { id: "mine", title: "Следи за своими лотами", pose: "wonder", targets: ['[data-guide-market-tab="mine"]'],
      summary: "В «Моих лотах» можно снять предложение и вернуть вещи в кладовую.",
      text: "Продажа другим игрокам может занять время. Новые предложения появляются у соседей при смене витрины. Если передумал, открой «Мои лоты» и верни товар. Обмен особыми материалами находится в отдельном разделе: там одну находку меняют на другую." },
  ],
  plesk: [
    { id: "rod-intro", title: "Начнём с удочки", pose: "fish", navigation: "plesk", showLabel: "Показать удочки", targets: ['[data-guide-plesk-offer="rod"]', '[data-guide-plesk-tab="tackle"]'],
      summary: "Удочку покупают один раз: она остаётся навсегда. Выбрать её можно перед рыбалкой.",
      text: "Удочки отличаются тем, какую рыбу помогают поймать. Покупка добавляет удочку в твою коллекцию, а снасти для конкретной вылазки выбираются перед отправлением. Сначала разберёмся со снастями, затем я покажу шансы улова." },
    { id: "hook-intro", title: "К удочке — крючок", pose: "hold", navigation: "plesk", showLabel: "Показать крючки", targets: ['[data-guide-plesk-offer="hook"]', '[data-guide-plesk-tab="tackle"]'],
      summary: "Крючок тоже остаётся навсегда. Он влияет на улов вместе с удочкой; выбрать его можно перед вылазкой.",
      text: "Удочка и крючок — отдельные снасти: их можно сочетать. Для некоторых рыб нужны определённые снасти. После рыбалки крючок не пропадает, покупать его заново для каждой вылазки не нужно." },
    { id: "bait-intro", title: "Наживка — на одну вылазку", pose: "present", navigation: "plesk", showLabel: "Показать наживки", targets: ['[data-guide-plesk-offer="bait"]', '[data-guide-plesk-tab="tackle"]'],
      summary: "Наживка помогает привлечь рыбу. На всю вылазку тратится 1 штука, но рыбачить можно и без неё.",
      text: "Запас наживок хранится в кладовой. Перед отправлением выбери одну из доступных наживок или оставь рыбалку без неё. Теперь, когда снасти знакомы, сравним их влияние на шансы улова — покупать ничего не понадобится." },
    { id: "rods", title: "Снасти меняют улов", pose: "fish", navigation: "plesk", revealOnOpen: true, showLabel: "Показать шансы", targets: ['[data-guide-plesk-detail="rod"] [data-guide-plesk-odds]', '[data-guide-plesk-offer="rod"]', '[data-guide-plesk-tab="tackle"]'],
      summary: "Вот шансы этой удочки на один особый улов. Сравни проценты: дорогая снасть не лучше для каждой рыбы.",
      text: "Удочки и крючки остаются навсегда. Они влияют на шансы особой рыбы; у некоторых видов есть требования к снастям. Покупка добавляет снасть в коллекцию. Выбрать её для вылазки можно перед отправлением на рыбалку." },
    { id: "bait", title: "Сравним шансы с наживкой", pose: "hold", navigation: "plesk", revealOnOpen: true, showLabel: "Показать шансы", targets: ['[data-guide-plesk-detail="bait"] [data-guide-plesk-odds]', '[data-guide-plesk-offer="bait"]', '[data-guide-plesk-tab="tackle"]'],
      summary: "А вот шансы с этой наживкой. Посмотри, какая рыба стала вероятнее, и подбери наживку под нужный улов.",
      text: "Открой наживку на прилавке и сравни шансы в её карточке. Запас наживок хранится в кладовой. Перед отправлением выбери наживку в снастях; можно рыбачить и без неё. Для знакомства покупать ничего не нужно." },
    { id: "catch", title: "Плёска покупает улов", pose: "present", navigation: "plesk", showLabel: "Показать улов", targets: ["[data-guide-plesk-sale]", '[data-guide-plesk-panel="fish"]', '[data-guide-plesk-tab="fish"]'],
      summary: "Открой «Улов»: выбери пойманную рыбу, количество и продай её Плёске.",
      text: "После получения рыболовной вылазки рыба появится в кладовой и на вкладке «Улов». Здесь видно цену продажи. Рыба также нужна для еды и заказов - перед продажей реши, сколько оставить. Кнопка «На рыбалку» открывает маршруты и выбор снастей." },
  ],
  meals: [
    { id: "hero", title: "Обед - это бонус скорости", pose: "hold", navigation: "meals", showLabel: "Еда для Мохлика", targets: ['[data-guide-meal-list="hero"] [data-meal]', '[data-guide-meal-consumer="hero"]'],
      summary: "Накорми Мохлика перед вылазкой или рыбалкой - он вернётся быстрее. Процент бонуса указан у каждого блюда.",
      text: "Это бафф: готовая еда временно ускоряет действие. Нажми «Съесть», когда решишь потратить одну порцию. Бонус дождётся следующей вылазки и не исчезнет вне игры. Во время похода накормить Мохлика уже нельзя; улов и шансы рыбы от обеда не меняются." },
    { id: "builder", title: "Шишколап тоже любит поесть", pose: "present", navigation: "meals", showLabel: "Еда для строителя", targets: ['[data-guide-meal-list="builder"] [data-meal]', '[data-guide-meal-consumer="builder"]'],
      summary: "Переключись на Шишколапа: его обед ускоряет следующую стройку или остаток уже начатой.",
      text: "У каждого блюда свой бонус для строителя - смотри процент в карточке. «Угостить» расходует одну порцию. Повторный обед не складывает бонусы, а готовую стройку ускорять уже не нужно." },
    { id: "portion", title: "Одна порция - один бонус", pose: "wonder", navigation: "meals", showLabel: "Показать блюда", targets: ["[data-guide-meal-action]", "[data-guide-meal-note]"],
      summary: "«Съесть» или «Угостить» тратит 1 блюдо. Нет готовой еды? «Готовить» откроет нужный рецепт.",
      text: "Сначала приготовь блюдо и забери его в кладовую, затем выбери получателя. Один подготовленный обед сохраняется до использования, два бонуса одновременно не складываются. Кнопка «Еда» рядом с таймером вылазки или стройки также покажет бонус и новое время до кормления." },
  ],
  orders: [
    { id: "requirements", title: "Разберём один заказ", pose: "wonder", targets: ["[data-guide-order-requirements]", "[data-order-id]"],
      summary: "В списке под заказом: сколько вещей у тебя / сколько нужно. Нажми на недостающее, чтобы узнать, где взять.",
      text: "Плёска и Шишколап просят припасы и материалы. Для каждого предмета показаны твой запас и нужное количество. Если у недостающего предмета есть доступный источник, нажатие откроет производство или подходящие вылазки." },
    { id: "reward", title: "Припасы в обмен на монеты", pose: "present", targets: ["[data-guide-order-reward]", "[data-order-id]"],
      summary: "Награда указана в карточке. «Отдать заказ» потратит нужные вещи и выдаст монеты.",
      text: "Кнопка станет доступна, когда собраны все припасы. После сдачи появится новая просьба. Сложный заказ можно заменить: проверь, осталась ли бесплатная замена или уже потребуется жемчуг." },
  ],
  expeditions: [
    { id: "routes", title: "Выбери, за чем идти", pose: "reach", targets: [target("expedition-activities"), "[data-route]", target("expedition-routes")],
      summary: "«За припасами», «На рыбалку» или «В шахту» - выбери занятие, затем маршрут.",
      text: "В карточке маршрута видны время, добыча и нужные припасы. Если шахта закрыта, нажми «Открыть шахту»: увидишь требования и сможешь перейти к строительству. Отправляться прямо сейчас не обязательно." },
    { id: "preparation", title: "Проверь перед выходом", pose: "carry", targets: [target("expedition-preparation"), "[data-route]", target("expedition-routes")],
      summary: "Проверь цену и снаряжение. После возвращения нажми «Забрать», чтобы получить находки.",
      text: "Перед рыбалкой здесь выбирают удочку, крючок и наживку. Вылазка занимает Мохлика на указанное время. Для получения находок понадобится место в кладовой; готовую добычу можно забрать позже." },
  ],
  workshop: [
    { id: "recipes", title: "Материалы превращаются в вещи", pose: "hold", targets: [target("workshop-recipes"), "[data-recipe]"],
      summary: "Выбери рецепт мастерской: увидишь результат, нужные материалы и время работы.",
      text: "Мастерская делает вещи из запасов кладовой. Нажми на рецепт и проверь состав. Недостающий материал с доступным источником можно нажать, чтобы перейти к его добыче или изготовлению. Новые рецепты и условия их открытия показаны в улучшениях здания." },
    { id: "queue", title: "Запусти и забери результат", pose: "present", targets: [target("workshop-queue"), "[data-recipe-order]", "[data-recipe]"],
      summary: "В рецепте кнопка «Начать» тратит материалы и ставит работу в очередь. Готовые вещи нужно забрать.",
      text: "Проверь количество партий перед запуском. Пока работа идёт, можно заниматься другими делами. После завершения забери результат в кладовую; если места мало, сначала используй или продай часть запасов." },
  ],
  builder: [
    { id: "status", title: "Шишколап - твой строитель", pose: "greet", targets: ["[data-builder-status]"],
      summary: "Шишколап строит и улучшает здания. Здесь видно, чем он занят сейчас.",
      text: "Выбери здание на карте и открой его улучшение: там указаны материалы, монеты и время стройки. Когда условия выполнены, можно начать работу. Шишколапу нужно закончить текущую стройку прежде, чем взяться за следующую." },
    { id: "actions", title: "Помоги мастеру", pose: "present", targets: ["[data-guide-builder-actions]"],
      summary: "В заказах Шишколапа можно обменять нужные ему материалы на монеты.",
      text: "Кнопки рядом ведут к текущей работе и просьбам строителя. Перед сдачей заказа посмотри, какие запасы нужны тебе для собственной стройки. Обустройство зданий открывает новые возможности поселения." },
  ],
};

export function parseSectionGuideProgress(raw: string | null, section: SectionGuideId): SectionGuideProgress | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const data = value as Record<string, unknown>;
    if (data.version !== 1 || !["started", "paused", "completed", "skipped"].includes(String(data.status))) return null;
    // Keep a deliberate completion/skip when copy is updated; resume unknown steps from the start.
    const stepId = sectionGuideLessons[section].find(step => step.id === data.stepId)?.id ?? sectionGuideLessons[section][0].id;
    return { version: 1, status: data.status as SectionGuideProgress["status"], stepId };
  } catch { return null; }
}

export function sectionGuideCanOpen(loaded: boolean, enabled: boolean, progress: SectionGuideProgress | null) {
  return loaded && enabled && (progress === null || progress.status === "started");
}

export type SectionGuideEvent = "start" | "next" | "back" | "pause" | "resume" | "skip" | "replay";
export function transitionSectionGuide(section: SectionGuideId, progress: SectionGuideProgress | null, event: SectionGuideEvent): SectionGuideProgress {
  const steps = sectionGuideLessons[section];
  const index = Math.max(0, steps.findIndex(step => step.id === progress?.stepId));
  if (event === "skip") return { version: 1, status: "skipped", stepId: steps[index].id };
  if (event === "pause") return { version: 1, status: "paused", stepId: steps[index].id };
  if (event === "replay") return { version: 1, status: "started", stepId: steps[0].id };
  if (event === "next") return { version: 1, status: index === steps.length - 1 ? "completed" : "started", stepId: steps[Math.min(steps.length - 1, index + 1)].id };
  if (event === "back") return { version: 1, status: "started", stepId: steps[Math.max(0, index - 1)].id };
  return progress?.status === "completed" || progress?.status === "skipped" ? progress : { version: 1, status: "started", stepId: steps[index].id };
}
