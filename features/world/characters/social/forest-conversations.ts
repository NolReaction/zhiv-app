import { FOREST_CONTEXT_CONVERSATIONS } from "./forest-context-conversations";
import type { ForestConversationCondition, ForestSocialFollowupRequest } from "./forest-social-context";
import type { ForestSpeaker } from "./forest-social";
import { FOREST_VILLAGER_CONVERSATIONS } from "./forest-villager-conversations";
import { FOREST_PURPOSE_CONVERSATIONS, type ForestSocialPurpose } from "./forest-purpose-conversations";

export type ForestConversation = {
  id: string;
  pair: `${ForestSpeaker}-${ForestSpeaker}`;
  weather?: "rain" | "night" | "day";
  place?: "river" | "home" | "garden" | "workshop" | "campfire" | "quarry";
  purpose?: Exclude<ForestSocialPurpose, "neighbour">;
  condition?: ForestConversationCondition; siteId?: string;
  followup?: Omit<ForestSocialFollowupRequest, "id">;
  lines: readonly { speaker: ForestSpeaker; text: string }[];
};

/** Complete exchanges: the setup and its reply always travel together. */
export const FOREST_CONVERSATIONS: readonly ForestConversation[] = [
  ...FOREST_PURPOSE_CONVERSATIONS,
  ...FOREST_CONTEXT_CONVERSATIONS,
  ...FOREST_VILLAGER_CONVERSATIONS,
  {
    id: "bm-berry-accounting", pair: "builder-mochlik", place: "garden", lines: [
      { speaker: "builder", text: "Ягоды с куста считай до того, как ешь." },
      { speaker: "mochlik", text: "А если я проверяю качество?" },
      { speaker: "builder", text: "Проверяй одну." },
      { speaker: "mochlik", text: "Вдруг хорошая попалась случайно?" },
      { speaker: "builder", text: "Тогда вторую проверю я." },
      { speaker: "mochlik", text: "Вот теперь это честная проверка." },
    ],
  },
  {
    id: "bm-soup-instructions", pair: "builder-mochlik", place: "campfire", lines: [
      { speaker: "mochlik", text: "У котелка вообще бывает инструкция?" },
      { speaker: "builder", text: "Да. Не трогай горячее." },
      { speaker: "mochlik", text: "Это не рецепт." },
      { speaker: "builder", text: "Зато самая полезная его часть." },
    ],
  },
  {
    id: "bm-workshop-measure", pair: "builder-mochlik", place: "workshop", lines: [
      { speaker: "mochlik", text: "Зачем мастерской несколько линеек?" },
      { speaker: "builder", text: "Чтобы не мерить на глаз." },
      { speaker: "mochlik", text: "А если глаз хороший?" },
      { speaker: "builder", text: "Пусть читает деления." },
    ],
  },
  {
    id: "bm-storage-labels", pair: "builder-mochlik", lines: [
      { speaker: "builder", text: "На ящике надо писать, что внутри." },
      { speaker: "mochlik", text: "Напишу: «Важное»." },
      { speaker: "builder", text: "А на соседнем?" },
      { speaker: "mochlik", text: "«Тоже не выбрасывать»." },
      { speaker: "builder", text: "И как ты потом найдёшь гвозди?" },
      { speaker: "mochlik", text: "По звуку. Потрясу каждый." },
    ],
  },
  {
    id: "bm-shelf-level", pair: "builder-mochlik", lines: [
      { speaker: "mochlik", text: "Полка чуть кривая — это страшно?" },
      { speaker: "builder", text: "Смотря что на ней." },
      { speaker: "mochlik", text: "Банка с ягодами." },
      { speaker: "builder", text: "Тогда страшно тому, кто под ней." },
    ],
  },
  {
    id: "bm-tool-loan", pair: "builder-mochlik", lines: [
      { speaker: "mochlik", text: "Дашь молоток на минутку?" },
      { speaker: "builder", text: "Для чего?" },
      { speaker: "mochlik", text: "А от этого меняется минутка?" },
      { speaker: "builder", text: "Нет. От этого меняется молоток." },
      { speaker: "mochlik", text: "Орех расколоть." },
      { speaker: "builder", text: "Тогда меняется мой ответ." },
    ],
  },
  {
    id: "bm-rest-chair", pair: "builder-mochlik", lines: [
      { speaker: "builder", text: "Хороший стул не должен скрипеть." },
      { speaker: "mochlik", text: "А как понять, что я отдыхаю?" },
      { speaker: "builder", text: "Ты сидишь и ничего не делаешь." },
      { speaker: "mochlik", text: "Да, но скрип это подчёркивает." },
    ],
  },
  {
    id: "bm-basket-bottom", pair: "builder-mochlik", lines: [
      { speaker: "mochlik", text: "Можно сделать корзину полегче?" },
      { speaker: "builder", text: "Можно убрать дно." },
      { speaker: "mochlik", text: "Но ягоды выпадут." },
      { speaker: "builder", text: "И станет ещё легче." },
    ],
  },
  {
    id: "bm-spare-nail", pair: "builder-mochlik", lines: [
      { speaker: "mochlik", text: "Зачем брать лишний гвоздь?" },
      { speaker: "builder", text: "На случай, если один согнётся." },
      { speaker: "mochlik", text: "Заранее не веришь в себя?" },
      { speaker: "builder", text: "Заранее не хочу идти обратно." },
    ],
  },
  {
    id: "bm-price-of-fast", pair: "builder-mochlik", lines: [
      { speaker: "mochlik", text: "А можно строить вдвое быстрее?" },
      { speaker: "builder", text: "Можно вдвое меньше мерить." },
      { speaker: "mochlik", text: "Вот!" },
      { speaker: "builder", text: "И втрое дольше переделывать." },
    ],
  },
  {
    id: "bm-rain-roof", pair: "builder-mochlik", weather: "rain", lines: [
      { speaker: "mochlik", text: "Вот дождь проверяет крышу бесплатно." },
      { speaker: "builder", text: "А результаты кладёт в ведро." },
      { speaker: "mochlik", text: "Удобно. Можно посчитать ошибки." },
      { speaker: "builder", text: "Лучше не доводить до второго ведра." },
    ],
  },
  {
    id: "bm-rain-laundry", pair: "builder-mochlik", weather: "rain", lines: [
      { speaker: "mochlik", text: "Дождь может сам помыть посуду?" },
      { speaker: "builder", text: "Может намочить." },
      { speaker: "mochlik", text: "Это уже половина работы." },
      { speaker: "builder", text: "Вторая половина почему-то всегда моя." },
    ],
  },
  {
    id: "bm-night-hammer", pair: "builder-mochlik", weather: "night", lines: [
      { speaker: "mochlik", text: "Есть молоток, который ночью не стучит?" },
      { speaker: "builder", text: "Есть. Лежит в ящике." },
      { speaker: "mochlik", text: "А если его достать?" },
      { speaker: "builder", text: "Тогда снова обычный молоток." },
    ],
  },
  {
    id: "bm-day-shade", pair: "builder-mochlik", weather: "day", lines: [
      { speaker: "mochlik", text: "В солнечный день тень тоже место." },
      { speaker: "builder", text: "Для чего?" },
      { speaker: "mochlik", text: "Чтобы подумать перед работой." },
      { speaker: "builder", text: "Только не до следующего утра." },
    ],
  },
  {
    id: "bp-river-size", pair: "builder-plesk", place: "river", lines: [
      { speaker: "builder", text: "В этой реке крупная рыба есть?" },
      { speaker: "plesk", text: "Есть. Только ко мне не торопится." },
      { speaker: "builder", text: "А как ты поняла, что крупная?" },
      { speaker: "plesk", text: "Мелкая так уверенно не отказывает." },
    ],
  },
  {
    id: "bp-workshop-rod", pair: "builder-plesk", place: "workshop", lines: [
      { speaker: "plesk", text: "В мастерской удочку починить можно?" },
      { speaker: "builder", text: "Удочку — да. Улов — нет." },
      { speaker: "plesk", text: "Улов я обычно чиню рассказом." },
      { speaker: "builder", text: "Тогда линейку тебе не выдавать." },
    ],
  },
  {
    id: "bp-campfire-fish", pair: "builder-plesk", place: "campfire", lines: [
      { speaker: "builder", text: "На сильном огне рыба быстро сгорит." },
      { speaker: "plesk", text: "Тогда надо чаще переворачивать." },
      { speaker: "builder", text: "Надо дождаться углей." },
      { speaker: "plesk", text: "В рыбалке ждать. В готовке ждать." },
      { speaker: "builder", text: "Можешь пока помыть посуду." },
      { speaker: "plesk", text: "Нет, ждать я всё-таки умею лучше." },
    ],
  },
  {
    id: "bp-fair-price", pair: "builder-plesk", lines: [
      { speaker: "builder", text: "Почему мелкую рыбу продают поштучно?" },
      { speaker: "plesk", text: "Каждую надо отдельно поймать." },
      { speaker: "builder", text: "Я тоже каждый гвоздь отдельно забиваю." },
      { speaker: "plesk", text: "Но они хотя бы от тебя не уплывают." },
    ],
  },
  {
    id: "bp-honest-scales", pair: "builder-plesk", lines: [
      { speaker: "builder", text: "На весах рыба меньше, чем в рассказе." },
      { speaker: "plesk", text: "На весы рассказ не положишь." },
      { speaker: "builder", text: "Вот за это я их и уважаю." },
      { speaker: "plesk", text: "Зато слушатели у них скучные." },
    ],
  },
  {
    id: "bp-knot", pair: "builder-plesk", lines: [
      { speaker: "builder", text: "Хороший узел не должен развязываться." },
      { speaker: "plesk", text: "А если я сама хочу его развязать?" },
      { speaker: "builder", text: "Должен." },
      { speaker: "plesk", text: "Требования как к умному соседу." },
    ],
  },
  {
    id: "bp-storage-smell", pair: "builder-plesk", lines: [
      { speaker: "builder", text: "Рыбе нужен отдельный ящик." },
      { speaker: "plesk", text: "Чтобы не потерялась?" },
      { speaker: "builder", text: "Чтобы молоток рыбой не пах." },
      { speaker: "plesk", text: "Зато такой молоток не потеряешь." },
    ],
  },
  {
    id: "bp-sitting-work", pair: "builder-plesk", lines: [
      { speaker: "builder", text: "Рыбачить сидя удобно." },
      { speaker: "plesk", text: "А строить сидя?" },
      { speaker: "builder", text: "Пока обсуждаем смету — очень." },
      { speaker: "plesk", text: "Значит, у нас похожее начало работы." },
    ],
  },
  {
    id: "bp-tool-care", pair: "builder-plesk", lines: [
      { speaker: "plesk", text: "Почему ты так бережёшь инструменты?" },
      { speaker: "builder", text: "Они молчат и помогают." },
      { speaker: "plesk", text: "Удочка тоже молчит." },
      { speaker: "builder", text: "Осталось договориться о втором." },
    ],
  },
  {
    id: "bp-fish-soup", pair: "builder-plesk", lines: [
      { speaker: "builder", text: "Сколько рыбы нужно на хороший суп?" },
      { speaker: "plesk", text: "Сначала скажи, сколько будет гостей." },
      { speaker: "builder", text: "А если гостей больше, чем рыбы?" },
      { speaker: "plesk", text: "Тогда сначала скажи, сколько воды." },
    ],
  },
  {
    id: "bp-rain-fish", pair: "builder-plesk", weather: "rain", lines: [
      { speaker: "builder", text: "Под дождём рыба лучше клюёт?" },
      { speaker: "plesk", text: "Иногда. Иногда просто я мокрее." },
      { speaker: "builder", text: "Как различить?" },
      { speaker: "plesk", text: "Посмотреть в ведро. Не на меня." },
    ],
  },
  {
    id: "bp-rain-canopy", pair: "builder-plesk", weather: "rain", lines: [
      { speaker: "plesk", text: "Нужен навес от такого дождя." },
      { speaker: "builder", text: "Над тобой или над удочкой?" },
      { speaker: "plesk", text: "А над всем берегом нельзя?" },
      { speaker: "builder", text: "Можно. Но это уже дом у воды." },
    ],
  },
  {
    id: "bp-night-bell", pair: "builder-plesk", weather: "night", lines: [
      { speaker: "plesk", text: "Ночью можно колокольчик на удочку." },
      { speaker: "builder", text: "И будить весь берег?" },
      { speaker: "plesk", text: "Если рыба крупная — пусть все видят." },
      { speaker: "builder", text: "Если мелкая — я тоже увижу." },
    ],
  },
  {
    id: "bp-day-hat", pair: "builder-plesk", weather: "day", lines: [
      { speaker: "builder", text: "В такой день шляпа нужнее удочки." },
      { speaker: "plesk", text: "Шляпой рыбу не поймаешь." },
      { speaker: "builder", text: "Без неё напечёт голову." },
      { speaker: "plesk", text: "Ладно. Аргумент без крючка, но зацепил." },
    ],
  },
  {
    id: "mp-river-float", pair: "mochlik-plesk", place: "river", lines: [
      { speaker: "mochlik", text: "Почему поплавок бывает неподвижным?" },
      { speaker: "plesk", text: "Потому что рыба не клюёт." },
      { speaker: "mochlik", text: "Может, он ей не нравится?" },
      { speaker: "plesk", text: "Ей крючок не нравится. И я понимаю." },
    ],
  },
  {
    id: "mp-garden-bait", pair: "mochlik-plesk", place: "garden", lines: [
      { speaker: "mochlik", text: "На ягоду с этого куста рыба клюнет?" },
      { speaker: "plesk", text: "Может быть. Решать будет рыба." },
      { speaker: "mochlik", text: "Я бы клюнул." },
      { speaker: "plesk", text: "Вот тебя от корзины и отгоняем." },
    ],
  },
  {
    id: "mp-campfire-tasting", pair: "mochlik-plesk", place: "campfire", lines: [
      { speaker: "mochlik", text: "Когда можно пробовать из котелка?" },
      { speaker: "plesk", text: "Когда остынет ложка." },
      { speaker: "mochlik", text: "А если я очень голодный?" },
      { speaker: "plesk", text: "Тогда особенно береги язык." },
    ],
  },
  {
    id: "mp-fish-description", pair: "mochlik-plesk", lines: [
      { speaker: "mochlik", text: "Какая у тебя самая большая рыба?" },
      { speaker: "plesk", text: "В ведре или в рассказе?" },
      { speaker: "mochlik", text: "А разница большая?" },
      { speaker: "plesk", text: "Зависит от того, кто слушает." },
      { speaker: "mochlik", text: "Я слушаю очень внимательно." },
      { speaker: "plesk", text: "Тогда лучше начнём с ведра." },
    ],
  },
  {
    id: "mp-price-question", pair: "mochlik-plesk", lines: [
      { speaker: "mochlik", text: "Если долго торговаться, цена упадёт?" },
      { speaker: "plesk", text: "Сначала устанем мы." },
      { speaker: "mochlik", text: "А потом?" },
      { speaker: "plesk", text: "Отдохнём и вспомним начальную цену." },
    ],
  },
  {
    id: "mp-quiet-fishing", pair: "mochlik-plesk", lines: [
      { speaker: "plesk", text: "Рыбалка любит тишину." },
      { speaker: "mochlik", text: "А шёпот считается тишиной?" },
      { speaker: "plesk", text: "Нет." },
      { speaker: "mochlik", text: "Тогда буду задавать вопросы реже." },
      { speaker: "plesk", text: "Отлично." },
      { speaker: "mochlik", text: "Насколько реже?" },
    ],
  },
  {
    id: "mp-lunch-shares", pair: "mochlik-plesk", lines: [
      { speaker: "mochlik", text: "Большая ложка делает суп вкуснее?" },
      { speaker: "plesk", text: "Она делает обед короче." },
      { speaker: "mochlik", text: "Зато раньше будет добавка." },
      { speaker: "plesk", text: "Если ты оставил её в котелке." },
    ],
  },
  {
    id: "mp-spare-hook", pair: "mochlik-plesk", lines: [
      { speaker: "mochlik", text: "Зачем столько запасных крючков?" },
      { speaker: "plesk", text: "Чтобы коряги тоже не скучали." },
      { speaker: "mochlik", text: "Они хорошо клюют?" },
      { speaker: "plesk", text: "Берут уверенно. Отпускают плохо." },
    ],
  },
  {
    id: "mp-storage-system", pair: "mochlik-plesk", lines: [
      { speaker: "mochlik", text: "Я бы складывал вкусное поближе." },
      { speaker: "plesk", text: "А запасы на завтра куда?" },
      { speaker: "mochlik", text: "Тоже вкусное?" },
      { speaker: "plesk", text: "Вот поэтому поближе не надо." },
    ],
  },
  {
    id: "mp-patience-practice", pair: "mochlik-plesk", lines: [
      { speaker: "mochlik", text: "Как научиться терпению?" },
      { speaker: "plesk", text: "Сядь. Подожди." },
      { speaker: "mochlik", text: "А способ побыстрее есть?" },
      { speaker: "plesk", text: "Ты пока даже не сел." },
    ],
  },
  {
    id: "mp-rain-water", pair: "mochlik-plesk", weather: "rain", lines: [
      { speaker: "mochlik", text: "Рыбе под дождём вообще всё равно?" },
      { speaker: "plesk", text: "Насчёт мокрых лап она не жалуется." },
      { speaker: "mochlik", text: "У неё нет лап." },
      { speaker: "plesk", text: "Вот. Одной заботой меньше." },
    ],
  },
  {
    id: "mp-rain-bucket", pair: "mochlik-plesk", weather: "rain", lines: [
      { speaker: "mochlik", text: "В дождь ведро само наполняется." },
      { speaker: "plesk", text: "Водой, заметь. Не рыбой." },
      { speaker: "mochlik", text: "Но домой не с пустым вернёшься." },
      { speaker: "plesk", text: "Этот ответ я уже пробовала." },
    ],
  },
  {
    id: "mp-night-supper", pair: "mochlik-plesk", weather: "night", lines: [
      { speaker: "mochlik", text: "Ночью перекус — это поздний ужин?" },
      { speaker: "plesk", text: "Или слишком ранний завтрак." },
      { speaker: "mochlik", text: "Тогда завтра можно ещё позавтракать?" },
      { speaker: "plesk", text: "Ты не время выясняешь, а меню." },
    ],
  },
  {
    id: "mp-day-shadow", pair: "mochlik-plesk", weather: "day", lines: [
      { speaker: "mochlik", text: "На солнце рыба меня лучше видит?" },
      { speaker: "plesk", text: "Если нависать над водой — вполне." },
      { speaker: "mochlik", text: "Может, узнает и обрадуется." },
      { speaker: "plesk", text: "Я бы на это наживку не тратила." },
    ],
  },
];
