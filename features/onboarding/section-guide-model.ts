import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import type { NavigableGuideSection } from "./section-guide-navigation";

export const sectionGuideIds = ["pantry", "market", "plesk", "orders", "expeditions", "workshop", "builder"] as const;
export type SectionGuideId = typeof sectionGuideIds[number];
/** Retired lessons keep their saved preferences without remaining navigable sections. */
export type SectionGuideStorageId = SectionGuideId | "meals";
const retiredMealStepIds = ["hero", "builder", "portion"] as const;
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
      text: "Обычный предмет покажет количество и сумму продажи. В «Холодильнике» листай горизонтальные ряды рыб: у каждого класса виден общий запас. Нажми вид - компактное окно уже выберет его для продажи. Готовая еда стоит отдельно. Просмотр ничего не продаёт. Крестик, Escape или нажатие вне окна вернут к карточке без продажи." },
    { id: "sale", title: "Монеты за лишние запасы", pose: "hold", targets: ["[data-guide-pantry-sale]", "[data-guide-pantry-item]"],
      summary: "Открой предмет, выбери количество и проверь сумму. «Продать торговцу» сразу обменяет вещи на монеты.",
      text: "Продажа происходит только после нажатия кнопки «Продать торговцу». Рыба списывается выбранными видами, по общей цене её класса; неизвестный старый остаток помечен «Без указания вида». Рыбу также покупает Плёска. Оставь нужное для стройки и заказов; продавать ради знакомства не обязательно." },
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
      text: "Форма покажет допустимую цену и сумму после сбора. Для рыбы откроется выбор оставшихся видов: проверь состав и нажми «Выставить лот». Просмотр ничего не выставляет. Монеты придут после покупки лота другим игроком; до неё вещи занимают кладовую. Быстро продать торговцу можно в кладовой." },
    { id: "mine", title: "Следи за своими лотами", pose: "wonder", targets: ['[data-guide-market-tab="mine"]'],
      summary: "В «Моих лотах» можно снять предложение и вернуть вещи в кладовую.",
      text: "Продажа другим игрокам может занять время. Новые предложения появляются у соседей при смене витрины. Если передумал, открой «Мои лоты» и верни товар. Обмен особыми материалами находится в отдельном разделе: там одну находку меняют на другую." },
  ],
  plesk: [
    { id: "rod-intro", title: "Начнём с удочки", pose: "fish", navigation: "plesk", showLabel: "Показать удочки", targets: ['[data-guide-plesk-offer="rod"]', '[data-guide-plesk-tab="tackle"]'],
      summary: "Удочку покупают один раз: она остаётся навсегда. Выбрать её можно перед рыбалкой.",
      text: "Удочка задаёт базовые шансы и чаще приносит рыбу своего класса. Покупка добавляет удочку в твою коллекцию, а снасти для конкретной вылазки выбираются перед отправлением. Сначала разберёмся со снастями, затем я покажу шансы улова." },
    { id: "hook-intro", title: "Крючок для удочки", pose: "hold", navigation: "plesk", showLabel: "Показать крючки", targets: ['[data-guide-plesk-offer="hook"]', '[data-guide-plesk-tab="tackle"]'],
      summary: "Крючок тоже остаётся навсегда. Он влияет на улов вместе с удочкой; выбрать его можно перед вылазкой.",
      text: "Удочка и крючок продаются отдельно: их можно сочетать. Легендарную рыбу открывает легендарная удочка. Крючок повышает шанс своего класса, но сам новые классы не открывает. После рыбалки крючок не пропадает, покупать его заново для каждой вылазки не нужно." },
    { id: "bait-intro", title: "Наживка на одну вылазку", pose: "present", navigation: "plesk", showLabel: "Показать наживки", targets: ['[data-guide-plesk-offer="bait"]', '[data-guide-plesk-tab="tackle"]'],
      summary: "Наживка помогает привлечь рыбу. На всю вылазку тратится 1 штука, но рыбачить можно и без неё.",
      text: "Запас наживок хранится в кладовой. Перед отправлением выбери одну из доступных наживок или оставь рыбалку без неё. Теперь, когда снасти знакомы, сравним их влияние на шансы улова. Покупать ничего не понадобится." },
    { id: "rods", title: "Снасти меняют улов", pose: "fish", navigation: "plesk", revealOnOpen: true, showLabel: "Показать шансы", targets: ['[data-guide-plesk-detail="rod"] [data-guide-plesk-odds]', '[data-guide-plesk-offer="rod"]', '[data-guide-plesk-tab="tackle"]'],
      summary: "Пять строк показывают шансы классов на одну рыбу. Стрелка сравнивает нынешний процент с выбранной снастью.",
      text: "Сравни нынешние снасти с выбранными: один класс может встречаться чаще, другой реже. Открытие таблицы не покупает и не надевает снасть. Удочки и крючки остаются навсегда. Вид внутри выпавшего класса выбирается случайно; после получения улова он откроется в книге." },
    { id: "bait", title: "Сравним шансы с наживкой", pose: "hold", navigation: "plesk", revealOnOpen: true, showLabel: "Показать шансы", targets: ['[data-guide-plesk-detail="bait"] [data-guide-plesk-odds]', '[data-guide-plesk-offer="bait"]', '[data-guide-plesk-tab="tackle"]'],
      summary: "В пяти строках сравни нынешние шансы и проценты с этой наживкой. Она усиливает свой класс.",
      text: "Стрелка показывает изменение шанса на одну рыбу. Просмотр ничего не покупает и не расходует. Запас наживок хранится в кладовой. Перед отправлением выбери наживку в снастях; можно рыбачить и без неё." },
    { id: "catch", title: "Плёска покупает улов", pose: "present", navigation: "plesk", showLabel: "Показать улов", targets: ["[data-guide-plesk-sale]", '[data-guide-plesk-panel="fish"]', '[data-guide-plesk-tab="fish"]'],
      summary: "В «Улове» классы сначала свёрнуты: нажми нужный и выбери рыбу. Продажу подтверждает кнопка «Продать».",
      text: "После возвращения увидишь виды и редкость. Нажми «Забрать»: рыба пополнит текущий запас, виды откроются в книге навсегда. Открой класс вручную и выбери из оставшихся видов. Повторный тап добавит 1 до доступного лимита; другой вид начнёт с 1. Поле и «Все» меняют количество. Только «Продать» спишет рыбу. Книга помнит и уже потраченные поимки." },
  ],
  orders: [
    { id: "requirements", title: "Разберём один заказ", pose: "wonder", targets: ["[data-guide-order-requirements]", "[data-order-id]"],
      summary: "В журнале заказов рядом с предметом: сколько вещей у тебя / сколько нужно. Нажми на недостающее, чтобы узнать, где взять.",
      text: "Журнал открывается кнопкой «Заказы» внизу карты. Плёска и Шишколап просят припасы и материалы. Рыбный заказ перед сдачей откроет выбор оставшихся видов: он уже заполнен, но рыбу можно заменить. Недостающие предметы ведут к источнику без запуска работы." },
    { id: "reward", title: "Припасы в обмен на монеты", pose: "present", targets: ["[data-guide-order-reward]", "[data-order-id]"],
      summary: "Награда указана в карточке. «Отдать заказ» потратит нужные вещи и выдаст монеты.",
      text: "Кнопка станет доступна, когда собраны все припасы. У рыбного заказа проверь выбор: тап заменяет рыбу, минус убирает одну, «Сбросить» и «Автозаполнение» помогают собрать состав. Только «Отдать заказ» в этом окне потратит рыбу. Закрытие ничего не расходует. Сложную просьбу можно заменить бесплатно или за жемчуг." },
  ],
  expeditions: [
    { id: "routes", title: "Выбери, за чем идти", pose: "reach", targets: [target("expedition-activities"), "[data-route]", target("expedition-routes")],
      summary: "Во «В путь» выбери припасы или рыбалку, затем маршрут. Шахта открывается отдельно на карте.",
      text: "В карточке маршрута видны время, добыча и нужные припасы. Нажатие открывает подготовку и само по себе не отправляет в путь. Шахта работает в собственной очереди; её ресурсы и фильтр времени находятся в меню шахты на карте." },
    { id: "preparation", title: "Проверь перед выходом", pose: "carry", targets: [target("expedition-preparation"), "[data-route]", target("expedition-routes")],
      summary: "Проверь припасы и снасти. «Ускорение едой» под таймером позволяет выбрать обед; он необязателен.",
      text: "В «Снастях» три ячейки: удочка, крючок и наживка. Нажми ячейку, сравни назначение и шанс; тап выберет твою снасть без покупки и отправления. Наживка уйдёт только при выходе. «Выбрать блюдо» покажет бонус и время, не тратя еду: порция уйдёт только после «Съесть 1». После возвращения нажми «Забрать», освободив место для находок." },
  ],
  workshop: [
    { id: "recipes", title: "Материалы превращаются в вещи", pose: "hold", targets: [target("workshop-recipes"), "[data-recipe]"],
      summary: "Рисунок и название показывают результат, ниже видны время и материалы. Нажатие сразу начнёт работу.",
      text: "Мастерская делает вещи из запасов кладовой. Состав и недостающие материалы показаны прямо в карточке. Нажми на нужный предмет, когда будешь готов потратить припасы: одно нажатие запускает одну работу. Если чего-то не хватает, карточка объяснит причину. Новые предметы и условия открытия показаны в улучшениях здания." },
    { id: "queue", title: "Запусти и забери результат", pose: "present", targets: [target("workshop-queue"), "[data-recipe-order]", "[data-recipe]"],
      summary: "Нажатие на предмет тратит материалы и занимает одно место. Готовую вещь нужно забрать.",
      text: "Ячейки остаются одинакового размера; в занятой показан предмет. Таймер меняется по секундам, например 4:30 или 1:02:03. Если ошибся, нажми ячейку: появятся «Удалить?» и таймер 5 секунд. Второе нажатие отменит работу; без второго нажатия она продолжится. Когда заняты обе очереди мастерской, «Верстак» и «Печь» собраны в одной плашке: каждая строка открывает своё производство. Готовую вещь забери в кладовую." },
  ],
  builder: [
    { id: "status", title: "Шишколап - твой строитель", pose: "greet", targets: ["[data-builder-status]"],
      summary: "Шишколап строит и улучшает здания. Здесь видно, чем он занят сейчас.",
      text: "Выбери здание на карте и открой его улучшение: там указаны материалы, монеты и время стройки. Когда условия выполнены, можно начать работу. Шишколапу нужно закончить текущую стройку прежде, чем взяться за следующую." },
    { id: "actions", title: "Помоги мастеру", pose: "present", targets: ["[data-guide-builder-actions]"],
      summary: "В заказах Шишколапа можно обменять нужные ему материалы на монеты.",
      text: "Кнопки рядом ведут к работе и журналу заказов строителя. В разговоре с Шишколапом есть «Ускорение едой»: выбери блюдо и проверь бонус. Только «Угостить 1» тратит порцию. Перед сдачей заказа посмотри, какие запасы нужны для твоей стройки." },
  ],
};

export function parseSectionGuideProgress(raw: string | null, section: SectionGuideStorageId): SectionGuideProgress | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const data = value as Record<string, unknown>;
    if (data.version !== 1 || !["started", "paused", "completed", "skipped"].includes(String(data.status))) return null;
    // Keep a deliberate completion/skip when copy is updated; resume unknown steps from the start.
    const stepIds: readonly string[] = section === "meals" ? retiredMealStepIds : sectionGuideLessons[section].map(step => step.id);
    const stepId = stepIds.find(id => id === data.stepId) ?? stepIds[0];
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
