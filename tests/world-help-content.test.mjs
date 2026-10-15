import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: "/tmp/zhiv-orders-journal-guides-help-vite", resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { worldHelpTopics, worldHelpGroups, searchWorldHelp, searchWorldHelpWithStatus } = await vite.ssrLoadModule("/features/world/ui/help/world-help-content.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { fishingClassOdds } = await vite.ssrLoadModule("/features/economy/domain/fishing.ts");
const { formatPearls } = await vite.ssrLoadModule("/features/economy/domain/money.ts");
const { constructionTimePearlPrice } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { CLICKER_IDLE_RESET_MS, CLICKER_LEVELS } = await vite.ssrLoadModule("/features/game/clicker-story.ts");
const { progressionRewardsCatalog } = await vite.ssrLoadModule("/features/game/progression-rewards.ts");
const topics = worldHelpTopics();
const topic = id => {
  const found = topics.find(entry => entry.id === id);
  assert.ok(found, `Missing topic ${id}`);
  return found;
};
const answer = id => {
  const entry = topic(id);
  return [...entry.paragraphs ?? [], ...entry.steps ?? [], entry.note ?? ""].join(" ");
};

test("help keeps durable topic links and separates concise answers into six useful groups", () => {
  const oldIds = ["start", "check-in", "level", "resources", "currency-shop", "plesk", "collection", "friend-profile", "wardrobe", "controls", "mochlik-life", "berry-garden", "campfire", "food", "resident-orders", "night", "production", "construction", "pearls", "rewards", "relics", "journeys", "future-world", "market", "saving", "feedback"];
  assert.equal(new Set(topics.map(entry => entry.id)).size, topics.length);
  assert.deepEqual(worldHelpGroups.map(group => group.id), ["start", "economy", "travel", "food", "mochlik", "account"]);
  for (const id of oldIds) topic(id);
  for (const group of worldHelpGroups) assert.ok(topics.some(entry => entry.group === group.id), `Empty group ${group.id}`);
  for (const entry of topics) {
    assert.ok(worldHelpGroups.some(group => group.id === entry.group), entry.id);
    assert.ok((entry.paragraphs?.length ?? 0) <= 1, `${entry.id}: use one lead and clear steps`);
    assert.ok((entry.steps?.length ?? 0) <= 4, `${entry.id}: keep steps short`);
    assert.ok(answer(entry.id).length <= 900, `${entry.id}: split a long answer into related questions`);
    for (const related of entry.relatedIds ?? []) {
      assert.notEqual(related, entry.id);
      topic(related);
    }
  }
  assert.deepEqual(worldHelpTopics(true), worldHelpTopics(false), "old presentation argument must not hide released rules");
});

test("search understands normal Russian questions, endings, ё and one-letter mistakes", () => {
  assert.equal(searchWorldHelp(topics, "  \n "), topics);
  for (const [query, expected] of [
    ["  пЛЁсКа  ", "plesk"],
    ["плеска", "plesk"],
    ["как приготовить уху", "campfire"],
    ["приготовить акулу", "campfire"],
    ["рыба дня скидка", "fish-day"],
    ["не хватает дерева", "resources"],
    ["не хватает досок", "production"],
    ["где взять камень", "resources"],
    ["где найти древесину", "resources"],
    ["мало места", "storage"],
    ["пропали монеты", "saving"],
    ["строителю еда", "builder-food"],
    ["заменить заказы", "resident-orders"],
    ["поймать редкую рыбу", "fishing"],
    ["не могу забрать урожай", "storage"],
    ["где найти друзей", "friend-profile"],
    ["мастеркая", "production"],
    ["клдаовая", "storage"],
    ["магазин удочек", "plesk"],
    ["как варить уху", "campfire"],
    ["расскажи про заказы", "resident-orders"],
    ["проект полянки", "third-house-stage"],
    ["как выставить больше лотов", "market-slots"],
    ["что значит открыть товар", "item-unlocks"],
    ["как сварить рыбный суп", "fish-soup"],
  ]) {
    const results = searchWorldHelp(topics, query);
    assert.equal(results[0]?.id, expected, `${query}: ${results.map(entry => entry.id).join(", ")}`);
  }
  assert.ok(searchWorldHelp(topics, "найти мохлика").some(entry => entry.id === "controls"));
  for (const query of ["несуществующая-тема-12345", "авыпролд", "++++", "рыба 99999999", "constructor", "toString", "__proto__"]) {
    assert.deepEqual(searchWorldHelp(topics, query), [], query);
  }
});

test("search responds while typing prefixes, preserving endings that resemble unfinished words", () => {
  for (const [query, expected] of [
    ["моне", "resources"], ["моне нужжж", null], ["масте", "production"], ["клад", "storage"],
    ["плё", "plesk"], ["рыб", "fishing"], ["зак", "resident-orders"], ["строи", "construction"],
    ["строител занят", "construction"], ["как улуч дом", "construction"],
  ]) {
    const results = searchWorldHelp(topics, query);
    assert.equal(results[0]?.id ?? null, expected, `${query}: ${results.map(entry => entry.id).join(", ")}`);
  }
  for (const query of ["мо", "мон", "моне", "монет", "монеты"]) {
    assert.ok(searchWorldHelp(topics, query).some(entry => entry.id === "resources"), query);
  }
  assert.equal(searchWorldHelp(topics, "пле\u0308ска")[0].id, "plesk", "decomposed ё also normalizes");
});

test("workshop help keeps general production first and finds the gift for specific questions", () => {
  for (const query of ["мастерская", "мастерской", "мастеркая", "масте"]) {
    assert.equal(searchWorldHelp(topics, query)[0]?.id, "production", query);
  }
  for (const query of ["стартовый набор", "набор для мастерской", "подарок мастерская", "мастеркая подарок"]) {
    assert.equal(searchWorldHelp(topics, query)[0]?.id, "workshop-starter", query);
  }
});

test("general and single-letter questions offer clearly labelled, bounded frequent topics", () => {
  const expected = ["start", "resources", "production", "construction", "resident-orders", "saving"];
  for (const query of ["как", "Как мне?", "что", "где", "почему", "как пожалуйста"]) {
    const result = searchWorldHelpWithStatus(topics, query);
    assert.equal(result.status, "frequent", query);
    assert.deepEqual(result.results.map(entry => entry.id), expected, query);
  }
  const short = searchWorldHelpWithStatus(topics, "м");
  assert.equal(short.status, "short");
  assert.deepEqual(short.results.map(entry => entry.id), expected);
  assert.equal(searchWorldHelpWithStatus(topics, "!!!!").status, "empty");
  assert.equal(searchWorldHelpWithStatus(topics, "  ").status, "all");
  assert.equal(searchWorldHelpWithStatus(topics, "несуществующая тема").status, "empty");
});

test("a single typo tolerates missing, extra, substituted and transposed letters without fuzzy numbers", () => {
  for (const query of ["моннты", "монтеы", "монетыы", "мнеты"]) {
    assert.equal(searchWorldHelp(topics, query)[0]?.id, "resources", query);
  }
  const numeric = [{ id: "timer", group: "start", title: "Таймер 25", keywords: "", summary: "" }];
  assert.equal(searchWorldHelp(numeric, "тайм 25").length, 1);
  for (const query of ["тайм 2", "тайм 26", "тайм 250", "ймер 25"]) assert.deepEqual(searchWorldHelp(numeric, query), [], query);
  const entries = [
    { id: "approximate", title: "Кладовая", keywords: "", summary: "", group: "economy" },
    { id: "exact", title: "Кладовщик", keywords: "кладоваяя", summary: "", group: "economy" },
  ];
  assert.equal(searchWorldHelp(entries, "кладоваяя")[0].id, "exact", "a deliberate exact keyword outranks a fuzzy title");
});

test("search prioritizes the question over a passing mention and requires every useful term", () => {
  const entries = [
    { id: "passing", title: "Отдых", summary: "", keywords: "", paragraphs: ["Можно найти монеты."], group: "start" },
    { id: "focused", title: "Как получить монеты?", summary: "", keywords: "", group: "start" },
    { id: "other", title: "Монеты и строительство", summary: "", keywords: "", group: "start" },
  ];
  const original = structuredClone(entries);
  assert.deepEqual(searchWorldHelp(entries, "монеты").map(entry => entry.id), ["focused", "other", "passing"]);
  assert.deepEqual(searchWorldHelp(entries, "монеты строительство").map(entry => entry.id), ["other"]);
  assert.deepEqual(entries, original, "search must not mutate source topics");
});

test("topic navigation points to existing buildings and valid destinations", () => {
  for (const entry of topics) {
    if (!entry.action) continue;
    assert.ok(entry.action.label.trim());
    const target = entry.action.target;
    if (target.kind === "station" || target.kind === "upgrade") {
      assert.ok(economyCatalog.buildings.some(building => building.id === target.stationId), entry.id);
      if (target.recipeId) assert.ok(economyCatalog.recipes.some(recipe => recipe.id === target.recipeId && recipe.buildingId === target.stationId));
    }
    if (target.kind === "profile") assert.ok(["profile", "mood", "friends", "settings"].includes(target.tab));
    if (target.kind === "expeditions" && target.sector) assert.ok(["forest", "coast", "caves"].includes(target.sector));
    assert.notEqual(target.kind, "food", `${entry.id}: released help uses real orders or contextual boost surfaces`);
    if (target.kind === "orders" && target.residentId) assert.ok(["plesk", "builder"].includes(target.residentId));
  }
  assert.deepEqual(topic("start").action.target, { kind: "station", stationId: "garden" });
  assert.deepEqual(topic("storage").action.target, { kind: "pantry" });
  assert.deepEqual(topic("mochlik-life").action.target, { kind: "profile", tab: "mood" });
  assert.deepEqual(topic("friend-profile").action.target, { kind: "profile", tab: "friends" });
  assert.deepEqual(topic("mining").action.target, { kind: "station", stationId: "quarry" });
  assert.deepEqual(topic("resident-orders").action.target, { kind: "orders" });
  assert.deepEqual(topic("food").action.target, { kind: "expeditions" });
  assert.deepEqual(topic("builder-food").action.target, { kind: "resident", residentId: "builder" });
});

test("order instructions point to the standalone journal and meal help stays beside the relevant work", () => {
  for (const id of ["tutorial-order", "second-stage-orders", "third-house-stage", "fourth-house-stage", "resident-orders"]) {
    assert.match(answer(id), /«Заказы» внизу/);
    assert.doesNotMatch(answer(id), /«Еда и заказы»|«Ещё» → «Еда/);
  }
  assert.equal(worldHelpGroups.find(group => group.id === "food").title, "Готовка и заказы");
  assert.match(answer("builder-food"), /или в разговоре с Шишколапом/);
});

test("beginner answers explain costs, receipt of results, blocked work and recovery without destructive advice", () => {
  assert.match(answer("start"), /урожай бесплатный/);
  assert.match(answer("production"), /монеты и материалы спишутся/);
  assert.match(answer("production"), /нехватка выделена рядом с количеством/);
  assert.match(answer("production"), /Рядом с рисунком указано название предмета, ниже - время и материалы/);
  assert.match(answer("production"), /одна работа начнётся сразу/);
  assert.match(answer("production"), /«Удалить\?» и таймер 5 секунд/);
  assert.match(answer("production"), /Второе нажатие за это время отменит работу и вернёт монеты и материалы/);
  assert.match(answer("production"), /Без второго нажатия работа продолжится/);
  assert.doesNotMatch(answer("production"), /«Отменить\?»|«Оставить»/);
  assert.doesNotMatch(answer("production"), /«Начать»|выберите нужный в подготовке/);
  assert.match(answer("production"), /Забрать/);
  assert.match(answer("construction"), /подтвердите завершение.*новый уровень.*освободится/);
  assert.match(answer("journeys"), /одну вылазку или собирает ягоды/);
  assert.match(answer("journeys"), /производства работают независимо/);
  assert.equal(topic("journeys").summary, "Лесные припасы и рыбалка");
  assert.doesNotMatch(answer("journeys"), /Добыча в шахте/);
  assert.match(answer("mining"), /Нажмите объект шахты на карте, чтобы открыть её отдельное меню/);
  assert.doesNotMatch(answer("mining"), /«В путь»/);
  assert.match(answer("journeys"), /Отзыв теряет добычу.*не возвращаются/);
  assert.match(answer("storage"), /Отмена лота не освобождает место/);
  assert.match(answer("storage"), /не пропадут/);
  assert.match(answer("saving"), /не очищайте данные браузера и не выходите из аккаунта/);
  assert.match(answer("saving"), /сверит прежнее действие с сервером/);
  assert.match(answer("saving"), /5 минут.*Вернуться в игру/);
  assert.match(answer("saving"), /таймеры уже начатых работ продолжаются/);
  assert.match(answer("saving"), /Продолжить здесь/);
  assert.match(answer("currency-shop"), /Покупка за реальные деньги.*недоступны/);
});

test("food guidance names the choice tile and makes spending an explicit second action", () => {
  for (const id of ["food", "builder-food"]) {
    assert.match(answer(id), /«Выбрать блюдо» в блоке «Ускорение едой»/);
    assert.doesNotMatch(answer(id), /нажмите «Еда» рядом/i);
  }
  assert.match(answer("food"), /Только «Съесть 1» потратит порцию/);
  assert.match(answer("builder-food"), /Только «Угостить 1» потратит порцию/);
  assert.match(answer("journeys"), /«Ускорение едой» под таймером/);
  assert.match(answer("journeys"), /открытие ничего не тратит/);
  assert.match(answer("journeys"), /У начатой работы показаны оставшееся время и находки/);
});

test("premium shop guidance uses wallet currency buttons while keeping checkout unavailable", () => {
  assert.match(answer("currency-shop"), /«\+» рядом с монетами.*«Золото».*рядом с жемчугом - «Жемчуг»/);
  assert.match(answer("currency-shop"), /Витрина находится у кошелька, а не в меню «Ещё»/);
  assert.match(answer("currency-shop"), /вверху магазина нажмите «Ввести промокод»/);
  assert.match(answer("currency-shop"), /Покупка за реальные деньги и обмен жемчуга на золото пока недоступны/);
  assert.match(answer("currency-shop-exchange"), /«\+» рядом с монетами.*вкладку «Золото». Обмен пока недоступен/);
  assert.doesNotMatch(answer("currency-shop"), /«Ещё» → «Магазин»/);
});

test("food, building speed and orders are distinct and use current catalog numbers", () => {
  const food = economyCatalog.food;
  for (const meal of food.meals) {
    const name = economyCatalog.items.find(item => item.id === meal.itemId).name;
    assert.ok(answer("food").includes(`${name} +${meal.heroSpeedBps / 100}%`));
  }
  assert.match(answer("food"), /не повышает|шансы рыбы не меняются/);
  assert.match(answer("food"), /бонусы не складываются/);
  assert.match(answer("food"), /не заменяет обязательные припасы/);
  assert.match(answer("food"), /Голодать.*не нужно/);
  assert.match(answer("food"), /офлайн/);
  for (const meal of food.meals) {
    const name = economyCatalog.items.find(item => item.id === meal.itemId).name;
    assert.ok(answer("builder-food").includes(`${name} +${meal.builderSpeedBps / 100}%`));
  }
  assert.match(answer("builder-food"), /оставшуюся часть/);
  assert.match(answer("builder-food"), /только один раз/);
  assert.match(answer("resident-orders"), /Обычные заказы дают монеты, не сытость/);
  assert.match(answer("resident-orders"), /не резервируются/);
  assert.ok(answer("resident-orders").includes(`${food.orders.slots} заказа`));
  assert.ok(answer("resident-orders").includes(`${food.orders.refreshSeconds / 3600} ч`));
  assert.ok(answer("resident-orders").includes(`${food.orders.freeReplacements} замены`));
  assert.ok(answer("resident-orders").includes(`${food.orders.replacementWindowSeconds / 3600} ч`));
  assert.ok(answer("resident-orders").includes(`${formatPearls(food.orders.replacementPricePearls)} жемчужин`));
  assert.match(answer("resident-orders"), /без ожидания/);
  assert.match(answer("resident-orders"), /с подтверждением/);
  assert.match(answer("resident-orders"), /Одновременных повторов нет/);
  assert.doesNotMatch(answer("resident-orders"), /через 30|ждёт 60/);
  assert.match(answer("campfire"), /Рыба другого класса автоматически не подставляется/);
  assert.match(answer("campfire"), /Сытный ужин требует редкую рыбу/);
});

test("fish-of-the-day guidance explains the actual discount and separates delivery profit from resale", () => {
  const shop = economyCatalog.fishing.shop;
  assert.ok(answer("fish-day").includes(`${shop.fishStock} рыб`));
  assert.ok(answer("fish-day").includes(`${100 - shop.fishPriceBps / 100}%`));
  assert.ok(answer("fish-day").includes(`${shop.refreshSeconds / 3600} ч`));
  assert.match(answer("fish-day"), /перепродажа Плёске убыточна/);
  assert.match(answer("fish-day"), /заказ может принести прибыль/);
  assert.match(answer("fish-day"), /Покупка не открывает вид/);
});

test("fishing help quotes the real probability per fish class without promising a rare catch", () => {
  const fishing = economyCatalog.fishing;
  const chance = fishingClassOdds({}, fishing, { rodId: "starfall_rod", hookId: "leviathan_hook", baitId: "star_bait" })
    .filter(odds => odds.rarity === "legendary")
    .reduce((sum, odds) => sum + odds.probability, 0);
  assert.ok(answer("fishing").includes(`${(chance * 100).toFixed(2).replace(".", ",")}%`));
  assert.match(answer("fishing"), /Каждая пойманная рыба получает класс/);
  assert.match(answer("fishing"), /Класс определяет цену и применение/);
  assert.match(answer("fishing"), /Вид открывается в коллекции/);
  assert.match(answer("plesk"), /одна наживка расходуется на весь поход/);
  assert.match(answer("collection"), /Продажа, готовка и заказ не стирают находку/);
});

test("fishing guidance distinguishes an authoritative catch, class stock art and personal discoveries", () => {
  assert.match(answer("plesk"), /нынешние проценты с выбранной снастью в пяти строках/);
  assert.match(answer("plesk"), /Открытие не покупает снасть/);
  assert.match(answer("fishing-result"), /Пока рыбалка идёт, видно только количество рыб/);
  assert.match(answer("fishing-result"), /Когда игра подтвердит возвращение.*виды, редкость и количество/);
  assert.match(answer("fishing-result"), /Нажмите «Забрать».*текущие запасы по видам и классам.*навсегда откроются в вашей книге/);
  assert.match(answer("fishing-result"), /прежних вылазок могут остаться общие классы рыб/);
  assert.match(answer("fishing-result"), /Книга помнит прежние поимки, даже если рыба потрачена/);
  assert.match(answer("fishing-result"), /В холодильнике, у Плёски и в выборе ингредиентов показана только оставшаяся рыба/);
  assert.deepEqual(topic("fishing-result").action.target, { kind: "expeditions", sector: "coast" });
  assert.ok(topic("collection").relatedIds.includes("fishing-result"));
});

test("fish selection guidance preserves current species, unknown stock and explicit final spending", () => {
  assert.match(answer("fish-selection"), /Выбор уже заполнен.*из текущих запасов/);
  assert.match(answer("fish-selection"), /добавить его или заменить одну выбранную рыбу/);
  assert.match(answer("fish-selection"), /минусом убирает одну.*«Сбросить».*«Автозаполнение»/);
  assert.match(answer("fish-selection"), /«Готовить», «Отдать заказ» или «Продать» подтвердит расход выбранных видов/);
  assert.match(answer("fish-selection"), /Закрытие выбора ничего не расходует/);
  assert.match(answer("fish-selection"), /обычных, учебных и этапных заказов/);
  assert.match(answer("fish-selection"), /«Без указания вида».*своего класса/);
  assert.match(answer("production"), /Отмена рыбной готовки возвращает выбранные виды/);
  assert.match(answer("resident-orders"), /сначала выберите виды, затем подтвердите сдачу/);
  assert.equal(searchWorldHelp(topics, "выбрать рыбу")[0]?.id, "fish-selection");
});

test("fish commerce answers require an explicit sale and keep market reservation distinct", () => {
  assert.match(answer("resources"), /В «Холодильнике» листайте горизонтальные ряды рыб по классам/);
  assert.match(answer("resources"), /Нажмите вид: компактное окно уже выберет его; проверьте количество и подтвердите продажу/);
  assert.match(answer("resources"), /Готовая еда стоит отдельно/);
  assert.match(answer("resources"), /Просмотр запаса ничего не тратит/);
  assert.match(answer("plesk"), /В «Улове» классы сначала свёрнуты. Нажмите класс и вид/);
  assert.match(answer("plesk"), /Повторный тап прибавляет 1 до доступного лимита; другой вид начинает с 1/);
  assert.match(answer("plesk"), /Поле и «Все» меняют количество. Только «Продать» спишет рыбу/);
  assert.match(answer("resources"), /Escape или нажатие вне окна закроют его без продажи и вернут к карточке/);
  assert.match(answer("plesk"), /Цена едина внутри класса/);
  assert.match(answer("market"), /Для рыбы проверьте виды и нажмите «Выставить лот»/);
  assert.match(answer("market"), /Монеты поступят, когда другой игрок купит ваш лот/);
  assert.match(answer("fish-selection"), /«Выставить лот» поместит их на рынок/);
  assert.match(answer("production"), /Таймер меняется по секундам: 4:30 или 1:02:03/);
  assert.match(answer("production"), /Одно место даёт один предмет/);
});

test("campfire and mining guidance matches compact categories, duration filters and safe equipment choices", () => {
  for (const label of ["Рыбные блюда", "Напитки", "Ягодные десерты", "Походные припасы"])
    assert.ok(answer("campfire").includes(`«${label}»`));
  for (const label of ["Все", "До 15 мин", "15 мин - 1 ч", "Дольше 1 ч"])
    assert.ok(answer("campfire").includes(`«${label}»`));
  assert.match(answer("campfire"), /работы остаются видны при любом фильтре/);
  assert.match(answer("campfire"), /Рыбный рецепт сначала откроет выбор видов.*«Готовить»/);
  assert.match(answer("mining"), /компактных строках видны добыча, количество и время/);
  assert.match(answer("fishing"), /три ячейки: удочка, крючок, наживка/);
  assert.match(answer("fishing"), /Тап по снасти выбирает её, без покупки и отправления/);
});

test("timers, production slots and prices derive from gameplay catalogs", () => {
  assert.ok(answer("check-in").includes(`${CLICKER_IDLE_RESET_MS / 1000} секунд`));
  assert.ok(answer("level").includes(`уровней ${CLICKER_LEVELS.length}`));
  assert.ok(answer("resources").includes(`${economyCatalog.localBuyer.payoutBps / 100}%`));
  for (const upgrade of economyCatalog.productionSlots.upgrades) {
    assert.ok(answer("production-slots").includes(`${upgrade.slots}-е - за ${formatPearls(upgrade.pricePearls)} жемчужин с дома ${upgrade.requiredHomeLevel}`));
  }
  assert.match(answer("production-slots"), /Третье до покупки второго показывает только замок/);
  assert.match(answer("production-slots"), /три одинаковых места/);
  assert.match(answer("production-slots"), /обе очереди.*в общей плашке видны «Верстак» и «Печь».*нажатие строки откроет нужное производство/);
  for (const [label, seconds] of [["1 мин", 60], ["1 ч", 3600], ["24 ч", 86400], ["48 ч", 172800]]) {
    assert.ok(answer("pearls").includes(`${label} - ${formatPearls(constructionTimePearlPrice(seconds))} жемчужин`));
  }
  assert.doesNotMatch(answer("pearls"), /Тариф: .* минут ожидания стоят/);
  assert.ok(answer("rewards").includes(`${progressionRewardsCatalog.dailyMinimumHours} часов`));
  assert.ok(answer("market").includes(`${economyCatalog.market.feeBps / 100}%`));
  assert.ok(answer("market").includes(`${economyCatalog.market.showcaseRefreshSeconds / 60} минут`));
  assert.match(answer("rewards"), /Открытие окна ничего не начисляет/);
  assert.match(answer("rewards"), /пропуск не сбрасывает шаг/);
});

test("profile guidance distinguishes mood, food, friends and future profile links", () => {
  assert.match(answer("level"), /«Профиль».*«Друзья».*шестерёнка настроек/);
  assert.match(answer("level"), /Как Мохлик\?/);
  assert.doesNotMatch(answer("level"), /«Настроение»/);
  assert.match(answer("mochlik-life"), /офлайн силы не расходуются/);
  assert.match(answer("mochlik-life"), /Настроение не заменяет сытость/);
  assert.match(answer("friend-profile"), /Карточки новой вкладки пока не открывают чужой профиль/);
  assert.match(answer("friend-profile"), /если разрешена видимость/);
  assert.match(answer("friend-profile"), /Кошелёк, запасы и задания остаются личными/);
  assert.match(answer("future-world"), /ещё готовятся/);
  assert.doesNotMatch(answer("friend-profile"), /онлайн|последний вход|чужие запасы/);
});

test("second-house guidance quotes all seven permanent orders and independent stone/clay production", () => {
  const course = economyCatalog.stageOrders.find(entry => entry.homeLevel === 2);
  assert.equal(course.orders.length, 7);
  for (const order of course.orders) {
    assert.ok(answer("second-stage-orders").includes(`${order.coins} монет`));
    for (const [id, count] of Object.entries(order.items)) {
      const item = economyCatalog.items.find(entry => entry.id === id);
      assert.ok(answer("second-stage-orders").includes(`${item.name} × ${count}`));
    }
  }
  assert.match(answer("second-stage-orders"), /не исчезают и не заменяются/);
  assert.match(answer("second-house-stage"), /50 мест/);
  assert.match(answer("second-house-stage"), /один предмет/);
  assert.match(answer("mining"), /одну глину за три минуты/);
  assert.match(answer("mining"), /одну отдельную очередь без платных слотов/);
  assert.match(answer("mining"), /Мохлик может гулять, рыбачить и собирать ягоды одновременно/);
  assert.match(answer("mining"), /Обед Мохлика не ускоряет шахту/);
  assert.match(answer("mining"), /блок ресурса или «Несколько ресурсов»/);
  for (const label of ["Все", "До 15 мин", "15 мин - 1 ч", "Дольше 1 ч"]) assert.ok(answer("mining").includes(`«${label}»`));
  assert.match(answer("mining"), /Текущая добыча видна при любом фильтре/);
  assert.match(answer("mining"), /проверить припасы перед запуском/);
  assert.match(answer("mining"), /У начатой работы видны добыча и оставшееся время/);
  assert.equal(searchWorldHelp(topics, "что делать после дома 2")[0]?.id, "second-house-stage");
});

test("house-three guidance explains seven full waits, guaranteed resin and optional storage", () => {
  const course = economyCatalog.stageOrders.find(entry => entry.homeLevel === 3);
  assert.equal(course.orders.length, 8); assert.equal(course.intervalSeconds, 82800);
  assert.deepEqual(course.completionRewards, { living_resin: 1 });
  assert.match(answer("third-house-stage"), /Первая из 8.*доступна сразу/);
  assert.match(answer("third-house-stage"), /через 23 ч/);
  assert.match(answer("third-house-stage"), /с передачи товаров.*не со смены суток UTC/);
  assert.match(answer("third-house-stage"), /Без ускорений.*минимум 185 ч/);
  assert.match(answer("third-house-stage"), /гарантированно.*Живая смола × 1/);
  assert.match(answer("third-house-stage"), /Жемчуг и обеды не сокращают интервалы/);
  assert.match(answer("third-house-stage"), /не истекают и не заменяются/);
  assert.match(answer("third-house-stage"), /Расширять кладовую необязательно/);
  assert.deepEqual(topic("third-house-stage").action.target, { kind: "orders" });
});

test("seller-slot and item-opening answers describe permanent rights and current pearl prices", () => {
  assert.match(answer("market-slots"), /Бесплатно доступны 5.*максимум.*10/);
  const prices = [50, 80, 120, 180, 250];
  assert.deepEqual(economyCatalog.market.slotPricesPearls.map(price => Number(formatPearls(price))), prices);
  for (const [index, price] of prices.entries()) assert.ok(answer("market-slots").includes(`${index + 6}-е - ${price} жемчужин`));
  assert.match(answer("market-slots"), /по очереди/);
  assert.match(answer("market-slots"), /остаётся навсегда/);
  assert.match(answer("market-slots"), /не увеличивают кладовую.*не меняют общую витрину/);
  assert.match(answer("item-unlocks"), /Один уровень дома не заменяет остальные требования/);
  assert.match(answer("item-unlocks"), /даже если вы продали весь запас или источник позже недоступен/);
  assert.match(answer("item-unlocks"), /Подаренный или купленный продвинутый предмет сам по себе не открывает/);
});

test("fish-soup guidance uses the authored recipe and distinct hero/builder bonuses", () => {
  const recipe = economyCatalog.recipes.find(entry => entry.id === "cook_fish_soup");
  const meal = economyCatalog.food.meals.find(entry => entry.itemId === "fish_soup");
  assert.ok(answer("fish-soup").includes(`дом ${recipe.requiredHomeLevel} и костёр уровня ${recipe.buildingLevel}`));
  for (const [id, count] of Object.entries(recipe.cost.items)) {
    assert.ok(answer("fish-soup").includes(`${economyCatalog.items.find(item => item.id === id).name} × ${count}`));
  }
  assert.ok(answer("fish-soup").includes(`${recipe.seconds / 60} минут`));
  assert.ok(answer("fish-soup").includes(`Мохлику +${meal.heroSpeedBps / 100}%`));
  assert.ok(answer("fish-soup").includes(`строителю +${meal.builderSpeedBps / 100}%`));
  assert.match(answer("fish-soup"), /Шахтёра не ускоряет/);
  assert.deepEqual(topic("fish-soup").action.target, { kind: "station", stationId: "dryer", recipeId: recipe.id });
});

test("current landmark answers separate early market restoration from later expeditions and planned boat orders", () => {
  assert.match(answer("market"), /С дома 2 восстановите мост и получите готовую стройку/);
  assert.match(answer("market"), /Вылазка для открытия не нужна/);
  assert.doesNotMatch(answer("market"), /хотя бы .* завершённая вылазка/);
  const landmarks = answer("future-world");
  assert.match(landmarks, /С дома 2.*мост.*рынок игроков/);
  assert.match(landmarks, /С дома 3 доступен маяк/);
  assert.match(landmarks, /С дома 4.*тропу и рощу.*древним руинам/);
  assert.match(landmarks, /Пароход с большими заказами.*ещё готовятся/);
  assert.match(landmarks, /не запускает рейс парохода/);
  assert.match(answer("relics"), /после восстановления моста.*«Обмен»/);
});

test("berry ladder describes each source tier, preparation time and hero or builder effect from the live catalog", () => {
  const ladder = answer("berry-tiers");
  for (const [home, cropId, dishId] of [[2, "grow_blueberries", "cook_blueberry_compote"], [3, "grow_currants", "cook_currant_jelly"],
    [4, "grow_blackberries", "cook_blackberry_preserve"], [5, "grow_cranberries", "cook_cranberry_glaze"]]) {
    const crop = economyCatalog.recipes.find(recipe => recipe.id === cropId);
    const dish = economyCatalog.recipes.find(recipe => recipe.id === dishId);
    const meal = economyCatalog.food.meals.find(meal => dish.rewards[meal.itemId]);
    const cropName = economyCatalog.items.find(item => crop.rewards[item.id]).name;
    const dishName = economyCatalog.items.find(item => item.id === meal.itemId).name;
    assert.ok(ladder.includes(`Дом ${home}, куст ${crop.buildingLevel}: ${cropName}, ${crop.seconds / 60} мин`));
    assert.ok(ladder.includes(`${dishName}: костёр ${dish.buildingLevel}, ${dish.seconds / 60} мин`));
    assert.ok(ladder.includes(`вылазки +${meal.heroSpeedBps / 100}%, стройки +${meal.builderSpeedBps / 100}%`));
  }
  assert.match(ladder, /Дом 1.*малина.*клубника/);
  assert.match(ladder, /Один слот даёт один предмет/);
  assert.match(ladder, /Блюдо ускоряет одну работу/);
});

test("gift budgets and project timing remain distinct from build durations and all help avoids em dashes", () => {
  const giftPearls = progressionRewardsCatalog.daily.reduce((sum, reward) => sum + reward.pearls, 0);
  assert.ok(answer("rewards").includes(`Полный цикл даёт ${formatPearls(giftPearls)} жемчужин`));
  assert.ok(answer("currency-shop").includes(`полный цикл даёт ${formatPearls(giftPearls)} жемчужин`));
  assert.match(answer("rewards"), /новые сутки UTC.*20 часов/);
  const fourth = economyCatalog.stageOrders.find(course => course.homeLevel === 4);
  const fifthHome = economyCatalog.buildings.find(building => building.id === "home").levels.find(level => level.level === 5);
  const minimumHours = ((fourth.orders.length - 1) * fourth.intervalSeconds + fifthHome.seconds) / 3600;
  assert.ok(answer("fourth-house-stage").includes(`Между поставками ${fourth.intervalSeconds / 3600} ч`));
  assert.ok(answer("fourth-house-stage").includes(`Без ускорений проект и дом 5 занимают минимум ${minimumHours} ч`));
  for (const entry of topics) assert.ok(!answer(entry.id).includes("—"), entry.id);
});
