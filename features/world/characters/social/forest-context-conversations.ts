import type { ForestConversation } from "./forest-conversations";
import type { ForestSpeaker } from "./forest-social";

const guests: readonly ForestSpeaker[] = ["mochlik", "builder", "lopukh", "kamneshmyg", "leaftail"];
const tradeGuests: readonly ForestSpeaker[] = ["mochlik", "plesk", "builder", "lopukh", "kamneshmyg"];
const fish: readonly [string, string, string, string][] = [
  ["Продаёшь сегодня рыбу?", "Сначала закончу со снастями.", "Не спеши. Я пока осмотрюсь.", "Хорошо. Для выбора нужна пауза."],
  ["Ручку корзины удобно держать?", "Пустую — да. С уловом тяжелее.", "Посмотрим, когда освободишь её.", "Договорились. Рыбу не торопим."],
  ["Поплавку нужна новая веточка?", "Эта ещё крепкая. Я проверила.", "Хорошо. Зря ветку ломать не буду.", "Лучше оставим над рекой тень."],
  ["Грузило дно не цепляет?", "Иногда. Тут неровные камни.", "Тогда выбирай гладкий край.", "И леску поберегу. Спасибо."],
  ["Что для снастей важнее: коробка?", "Чтобы крючки лежали отдельно.", "Значит, нужны перегородки.", "Да. И чтоб открывалось сухими лапами."],
];
const trade: readonly [string, string, string, string][] = [
  ["Сначала смотреть или спрашивать?", "Смотреть. А потом расскажу подробнее.", "Так я пойму, что мне нужно.", "И не унесёшь лишний мешок."],
  ["Для лески найдётся сухое место?", "Вещи у меня закрыты от сырости.", "Рыбацким снастям это тоже нужно.", "Особенно если дорога длинная."],
  ["Ящики под тяжёлое проверяешь?", "Сначала дно. Потом завязки.", "Верно. Ручка без дна не поможет.", "Я один раз проверил. Запомнил."],
  ["Стружку из ящиков выбрасываешь?", "Сухую отдельно собираю.", "При растопке пригодится.", "А проход оставляю свободным."],
  ["Камни с узором отдельно лежат?", "Да. Острыми краями не трутся.", "Иначе весь рисунок в царапинах.", "Вот почему укладка тоже работа."],
];
const window: readonly [string, string, string, string][] = [
  ["В окошко хорошо слышно?", "Да. Тут можно спокойно поболтать.", "Тогда не буду стучать в дверь.", "Спасибо. Я тебя и так заметил."],
  ["Я ненадолго. Как дорога была?", "Сыровато. Ящики пришлось укрыть.", "У воды без крышки никуда.", "Ты это лучше меня знаешь."],
  ["Раму отсюда удобно осматривать.", "А мне удобно отвечать из дома.", "Согласен. Лишний круг не нужен.", "И лапы после прогулки отдыхают."],
  ["Под навесом щепки не мокнут?", "Если не класть у самого края.", "Верно. Ветер и под крышу заберётся.", "Поэтому всё держу над землёй."],
  ["Света в окошке хватает?", "Для записей — да. Я ближе сижу.", "Я у пещеры тоже сначала смотрю.", "Хорошая привычка для любой работы."],
];
function questions(purpose: "fish" | "trade" | "window", host: "plesk" | "leaftail",
  speakers: readonly ForestSpeaker[], rows: readonly [string, string, string, string][]): ForestConversation[] {
  return rows.map(([first, second, third, fourth], index) => ({ id: `${purpose}-${speakers[index]}-${host}-care`,
    pair: `${speakers[index]}-${host}`, purpose, lines: [
      { speaker: speakers[index], text: first }, { speaker: host, text: second },
      { speaker: speakers[index], text: third }, { speaker: host, text: fourth },
    ] }));
}
const speakers: readonly ForestSpeaker[] = ["mochlik", "plesk", "builder", "lopukh", "kamneshmyg", "leaftail"];
const pairs = speakers.flatMap((guest, index) => speakers.slice(index + 1).map(host => [guest, host] as const));
function factStories(kind: "wood" | "mining" | "fishing", worker: ForestSpeaker,
  rows: readonly [string, string, string, string][]): ForestConversation[] {
  return speakers.filter(id => id !== worker).map((guest, index) => {
    const [first, second, third, fourth] = rows[index];
    return { id: `recent-${kind}-${guest}`, pair: `${guest}-${worker}`, condition: kind,
      lines: [{ speaker: guest, text: first }, { speaker: worker, text: second },
        { speaker: guest, text: third }, { speaker: worker, text: fourth }] };
  });
}
/** Every claim about a completed action requires a live confirmed event. Weather
 * and remembered meetings use the owner's clock; neither fabricates rewards. */
export const FOREST_CONTEXT_CONVERSATIONS: readonly ForestConversation[] = [
  ...questions("fish", "plesk", guests, fish), ...questions("trade", "leaftail", tradeGuests, trade),
  ...questions("window", "leaftail", tradeGuests, window),
  ...pairs.map(([guest, host]): ForestConversation => ({ id: `passing-again-${guest}-${host}`, pair: `${guest}-${host}`,
    purpose: "passing", condition: "recent-pair", lines: [
      { speaker: guest, text: "Опять встретились! Как прогулка?" }, { speaker: host, text: "Хорошо. Давай оставим проход." },
    ] })),
  ...pairs.map(([guest, host]): ForestConversation => ({ id: `rain-care-${guest}-${host}`, pair: `${guest}-${host}`, weather: "rain", lines: [
    { speaker: guest, text: "Дождь. Долго снаружи не стой." }, { speaker: host, text: "Перекинемся словом и под крышу." },
    { speaker: guest, text: "А дело дождётся сухих лап." }, { speaker: host, text: "Верно. На тропе сейчас скользко." },
  ] })),
  ...pairs.map(([guest, host]): ForestConversation => ({ id: `night-quiet-${guest}-${host}`, pair: `${guest}-${host}`, weather: "night", lines: [
    { speaker: guest, text: "Уже темнеет. Дела заканчиваешь?" }, { speaker: host, text: "Остальное оставлю на светлый день." },
    { speaker: guest, text: "Тогда поговорим потише." }, { speaker: host, text: "Да. Соседям тоже нужен отдых." },
  ] })),
  ...speakers.filter(id => id !== "builder").map((guest): ForestConversation => ({ id: `built-${guest}-builder`,
    pair: `${guest}-builder`, condition: "construction", lines: [
      { speaker: guest, text: "Постройка готова. Лапам отдых?" }, { speaker: "builder", text: "Да. Последний осмотр закончен." },
      { speaker: guest, text: "Можно теперь спокойно любоваться." }, { speaker: "builder", text: "Любуюсь. И мысленно всё проверяю." },
    ] })),
  ...factStories("wood", "lopukh", [
    ["Слышал, брёвна уже уложены?", "Да. Теперь не раскатятся по тропе.", "Уши тоже заслужили отдых.", "Они ещё слушают, как лес шумит."],
    ["После брёвен лапы не гудят?", "Гудят. Посижу, песню досочиню.", "Только тихо. Я рыбу слушаю.", "Тогда припев будет про тишину."],
    ["Разгрузился? Дай лапам передышку.", "Уже уложил. Можно не спешить.", "Тяжёлое всегда держи снизу.", "Да. И тропку оставляю свободной."],
    ["От дерева пыль мягче каменной?", "Мягче. Но с лап всё равно смываю.", "Значит, после работы мы похожи.", "У меня только уши дольше сохнут."],
    ["Брёвна перед домом уложил?", "Да. Не на землю и не на проход.", "Хорошие припасы любят сухое место.", "И честный отдых после переноски."],
  ]),
  ...factStories("mining", "kamneshmyg", [
    ["Из пещеры уже вернулся?", "Да. Сначала отряхнул пыль.", "А теперь можно про камни?", "Теперь можно. Только не спеша."],
    ["После добычи к реке не тянешь?", "Тянет лапы сполоснуть.", "И спокойно посидеть у воды.", "Она после камней особенно тихая."],
    ["Добыча закончена. Упоры проверил?", "Проверил перед выходом.", "Так завтра спокойнее начинать.", "И сегодня можно спокойно отдыхать."],
    ["В пещере лесную песню слышно?", "Нет. Зато здесь теперь слышу.", "Тогда спою после твоего отдыха.", "Хорошо. Пока послушаем листья."],
    ["После добычи узел мешка цел?", "Проверил. И пыль с него стряхнул.", "Так и хранить спокойнее.", "Да. Сначала порядок, потом чай."],
  ]),
  ...factStories("fishing", "plesk", [
    ["Рыбалку закончила?", "Да. Теперь снасти просушу.", "Даже удочке положен отдых?", "Особенно леске и мокрым узлам."],
    ["Корзина после рыбалки цела?", "Да. Ручка держится хорошо.", "Тогда не буду зря тревожить узлы.", "Спасибо. Просто дай ей просохнуть."],
    ["Удочку после рыбалки убрала?", "Да. Крючок уже закрыт.", "Значит, можно рядом присесть.", "Можно. Тропка свободна."],
    ["Рыбалка окончена. Вода спокойна?", "Спокойна. Я тоже передохну.", "Понимаю. После дела лучше не спешить.", "Особенно когда берег тёплый."],
    ["После рыбалки всё просушиваешь?", "Да. Сырые снасти в ящик не кладу.", "У путешественников такое же правило.", "Значит, рыбаки тоже немного в пути."],
  ]),
  { id: "window-builder-remembered", pair: "builder-leaftail", purpose: "window", condition: "window-inspected", lines: [
    { speaker: "leaftail", text: "Спасибо, что окошко осмотрел." }, { speaker: "builder", text: "Посмотрел снаружи. Ремонт не начинал." },
    { speaker: "leaftail", text: "Теперь хоть ясно, где цепляется." }, { speaker: "builder", text: "Да. А пока закрывай без рывка." },
  ] },
  { id: "window-builder-unfinished", pair: "builder-leaftail", purpose: "window",
    continuation: { kind: "inspect-window", result: "unfinished" }, lines: [
    { speaker: "leaftail", text: "С окошком пока не закончили?" }, { speaker: "builder", text: "Осмотр отложил. Раму не трогал." },
    { speaker: "leaftail", text: "Хорошо, буду открывать без рывка." }, { speaker: "builder", text: "Да. Спешка здесь не поможет." },
  ] },
  { id: "window-woodpile-lopukh-remembered", pair: "lopukh-leaftail", purpose: "window", condition: "woodpile-checked", lines: [
    { speaker: "leaftail", text: "До поленницы добрался?" }, { speaker: "lopukh", text: "Да. Осмотрел место, где кладу брёвна." },
    { speaker: "leaftail", text: "Вот и дело после разговора." }, { speaker: "lopukh", text: "Теперь можно спокойно передохнуть." },
  ] },
  { id: "window-woodpile-lopukh-unfinished", pair: "lopukh-leaftail", purpose: "window",
    continuation: { kind: "check-woodpile", result: "unfinished" }, lines: [
    { speaker: "leaftail", text: "С поленницей тогда не вышло?" }, { speaker: "lopukh", text: "Тот осмотр пришлось отложить." },
    { speaker: "leaftail", text: "Ничего. Не каждый план сбывается." }, { speaker: "lopukh", text: "Особенно если у плана длинные уши." },
  ] },
  { id: "woodpile-lopukh-remembered", pair: "lopukh-leaftail", purpose: "trade", condition: "woodpile-checked", lines: [
    { speaker: "leaftail", text: "У поленницы всё спокойно?" }, { speaker: "lopukh", text: "Осмотрел место, где кладу брёвна." },
    { speaker: "leaftail", text: "С мешком теперь не придётся петлять." }, { speaker: "lopukh", text: "Тропинка нужна всем соседям." },
  ] },
];
