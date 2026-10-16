import type { ForestConversation } from "./forest-conversations";
import type { ForestSpeaker } from "./forest-social";

export type ForestSocialPurpose = "neighbour" | "fish" | "trade" | "window" | "passing";
export type ForestPurposeConversation = ForestConversation & { purpose: Exclude<ForestSocialPurpose, "neighbour"> };

const fishQuestions: readonly [ForestSpeaker, string, string, string, string][] = [
  ["mochlik", "Какую наживку рыба любит?", "Смотря какая. Подбирай под улов.", "У каждой рыбы свои привычки?", "Да. Перед рыбалкой сверяй снасти."],
  ["builder", "Корзину под улов укрепить нужно?", "Ручку бы. Рыба бывает тяжёлая.", "Осмотрю, когда закончишь ловить.", "Спасибо. Пустую принесу к дому."],
  ["lopukh", "Из лёгкой ветки удочка получится?", "Если гнётся ровно и без трещин.", "Отложу такую. Сначала проверю.", "И кору сними, лапам будет мягче."],
  ["kamneshmyg", "Для грузила какой камень годится?", "Небольшой, гладкий, без острых граней.", "Поищу после добычи. Леску жалко.", "Верно. Острый край её перетрёт."],
  ["leaftail", "Что рыбаки чаще у тебя спрашивают?", "Удочки и наживку под разную рыбу.", "Значит, одного набора мало?", "Да. Находку подбирают под улов."],
];
const windowQuestions: readonly [ForestSpeaker, string, string, string, string][] = [
  ["mochlik", "Листохвост, ты дома? Есть минутка?", "Я у окна. Что присматриваешь?", "Хочу понять, что в лавке появилось.", "Находки и припасы. Загляни спокойно."],
  ["plesk", "Не выходи. Я только про ящики.", "Слушаю из окна. Рыбу несёшь?", "Пока нет. Нужны сухие под снасти.", "Посмотрю, где крышка держит плотно."],
  ["builder", "Окошко не заедает после дождя?", "Чуть цепляет край. Отсюда слышно.", "Обмерю снаружи. Ты оставайся дома.", "Спасибо. Уберу вещи от рамы."],
  ["lopukh", "Я у окошка. Тебе дров отложить?", "Да, только сухих. Сырые дымят.", "Проверю поленницу после прогулки.", "А я освобожу место под навесом."],
  ["kamneshmyg", "В окно слышно? Вижу камень в лавке.", "Слышно. С узором, я его отложил.", "Потом сравним с камнем из пещеры.", "Заглядывай. Весы тоже проверим."],
];
const tradeQuestions: readonly [ForestSpeaker, string, string, string, string][] = [
  ["mochlik", "Что лучше взять для маленьких дел?", "Сначала посмотри, чего не хватает.", "Тогда сверю со складом и вернусь.", "Хороший план. Лавка подождёт."],
  ["plesk", "Хрупкие вещи во что заворачиваешь?", "В сухой мох. И кладу отдельно.", "Для снастей тоже удобно было бы.", "Посмотри, только крючки закрой."],
  ["builder", "Эти доски сухие? Хочу проверить.", "Проверяй. Я храню их над землёй.", "Хорошо. Сырость ведёт древесину.", "Вот зачем у ящиков ножки."],
  ["lopukh", "Древесину у тебя быстро разбирают?", "Когда для дела берут, а не про запас.", "Пойду ровнее уложу поленницу.", "И оставь проход. С мешком удобнее."],
  ["kamneshmyg", "Камень в мешке не пробил дно?", "Нет, подложил плотную ткань.", "Правильно. Острые края режут узел.", "Спасибо, ещё раз проверю перед темнотой."],
];
const passing: readonly [ForestSpeaker, ForestSpeaker, string, string][] = [
  ["mochlik", "plesk", "Как река? Есть вести от поплавка?", "Есть. Забегай, когда освобожусь."],
  ["mochlik", "builder", "Как стройка? Все доски на месте?", "Проверил. Сейчас лапы отдыхают."],
  ["mochlik", "lopukh", "Уши уже нашли хорошую тропку?", "Да! Но я сначала тебя пропущу."],
  ["mochlik", "kamneshmyg", "Идёшь к пещере или просто гуляешь?", "Сейчас гуляю. Добычи пока нет."],
  ["mochlik", "leaftail", "Лавку на прогулку отпустили?", "Ненадолго. Проветрю хвост и домой."],
  ["plesk", "builder", "Не видел сухую досочку у берега?", "Проверю возле дома. После отдыха."],
  ["plesk", "lopukh", "Ты сегодня без лесной песни?", "Берегу припев для вечерней тропки."],
  ["plesk", "kamneshmyg", "Пыль с лап отряхнул перед рекой?", "Конечно. Камни оставил у пещеры."],
  ["plesk", "leaftail", "Проветриваешь хвост?", "И узнаю, что нового у соседей."],
  ["builder", "lopukh", "У топора рукоять крепко сидит?", "Проверил. Можно спокойно гулять."],
  ["builder", "kamneshmyg", "Как тропа к каменоломне?", "Твёрдая. И шагать можно не спеша."],
  ["builder", "leaftail", "У фургона колёса не скрипят?", "Прислушаюсь, когда вернусь домой."],
  ["lopukh", "kamneshmyg", "Камень или дерево прочнее?", "Смотря для чего. Обсудим на пеньке."],
  ["lopukh", "leaftail", "От ящиков стружки не набрал?", "Немного. Отложил тебе сухие щепки."],
  ["kamneshmyg", "leaftail", "Весы от каменной пыли протёр?", "Да. Теперь опять видны деления."],
];
function questions(purpose: "fish" | "window" | "trade", host: "plesk" | "leaftail",
  rows: readonly [ForestSpeaker, string, string, string, string][]): ForestPurposeConversation[] {
  return rows.map(([guest, first, second, third, fourth]) => ({ id: `${purpose}-${guest}-${host}`, pair: `${guest}-${host}`, purpose,
    lines: [{ speaker: guest, text: first }, { speaker: host, text: second }, { speaker: guest, text: third }, { speaker: host, text: fourth }] }));
}
export const FOREST_PURPOSE_CONVERSATIONS: readonly ForestPurposeConversation[] = [
  ...questions("fish", "plesk", fishQuestions), ...questions("window", "leaftail", windowQuestions),
  ...questions("trade", "leaftail", tradeQuestions),
  ...passing.map(([guest, host, first, second]): ForestPurposeConversation => ({ id: `passing-${guest}-${host}`,
    pair: `${guest}-${host}`, purpose: "passing", lines: [{ speaker: guest, text: first }, { speaker: host, text: second }] })),
];
