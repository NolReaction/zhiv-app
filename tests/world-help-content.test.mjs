import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { worldHelpTopics, worldHelpGroups, searchWorldHelp, searchWorldHelpWithStatus } = await vite.ssrLoadModule("/features/world/world-help-content.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const { fishingOdds } = await vite.ssrLoadModule("/features/economy/fishing.ts");
const { formatPearls } = await vite.ssrLoadModule("/features/economy/money.ts");
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
    if (target.kind === "profile") assert.ok(["profile", "mood", "friends"].includes(target.tab));
    if (target.kind === "expeditions" && target.sector) assert.ok(["forest", "coast", "caves"].includes(target.sector));
  }
  assert.deepEqual(topic("start").action.target, { kind: "station", stationId: "garden" });
  assert.deepEqual(topic("storage").action.target, { kind: "pantry" });
  assert.deepEqual(topic("mochlik-life").action.target, { kind: "profile", tab: "mood" });
  assert.deepEqual(topic("friend-profile").action.target, { kind: "profile", tab: "friends" });
  assert.deepEqual(topic("mining").action.target, { kind: "expeditions", sector: "caves" });
});

test("beginner answers explain costs, receipt of results, blocked work and recovery without destructive advice", () => {
  assert.match(answer("start"), /урожай бесплатный/);
  assert.match(answer("production"), /монеты и материалы спишутся сразу/);
  assert.match(answer("production"), /красный материал.*получению/);
  assert.match(answer("production"), /Забрать/);
  assert.match(answer("construction"), /подтвердите завершение.*новый уровень.*освободится/);
  assert.match(answer("journeys"), /одно занятие/);
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
  assert.match(answer("resident-orders"), /только монеты, не сытость/);
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
  assert.match(answer("campfire"), /редкий улов автоматически не подставляется/);
  assert.match(answer("campfire"), /редкую или эпическую/);
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

test("fishing help quotes the real probability per special attempt without promising a rare catch", () => {
  const fishing = economyCatalog.fishing;
  const chance = fishingOdds({}, fishing, { rodId: "starfall_rod", hookId: "leviathan_hook", baitId: "firefly_bait" })
    .filter(odds => fishing.fish.some(fish => fish.itemId === odds.itemId && fish.rarity === "legendary"))
    .reduce((sum, odds) => sum + odds.probability, 0);
  assert.ok(answer("fishing").includes(`${(chance * 100).toFixed(2).replace(".", ",")}%`));
  assert.match(answer("fishing"), /одной особой попытке, а не к каждой рыбе/);
  assert.match(answer("fishing"), /Особая попытка тоже может дать обычную рыбу/);
  assert.match(answer("fishing"), /Гарантированные речные рыбы не дают дополнительных бросков/);
  assert.match(answer("plesk"), /одна наживка расходуется на весь поход/);
  assert.match(answer("collection"), /Продажа, готовка и заказ не стирают находку/);
});

test("timers, production slots and prices derive from gameplay catalogs", () => {
  assert.ok(answer("check-in").includes(`${CLICKER_IDLE_RESET_MS / 1000} секунд`));
  assert.ok(answer("level").includes(`уровней ${CLICKER_LEVELS.length}`));
  assert.ok(answer("resources").includes(`${economyCatalog.localBuyer.payoutBps / 100}%`));
  for (const upgrade of economyCatalog.productionSlots.upgrades) {
    assert.ok(answer("production-slots").includes(`${upgrade.slots}-е — за ${formatPearls(upgrade.pricePearls)} жемчужин с дома ${upgrade.requiredHomeLevel}`));
  }
  assert.ok(answer("pearls").includes(`${economyCatalog.constructionSpeedup.secondsPerPearl / 60} минут`));
  assert.ok(answer("rewards").includes(`${progressionRewardsCatalog.dailyMinimumHours} часов`));
  assert.ok(answer("market").includes(`${economyCatalog.market.feeBps / 100}%`));
  assert.ok(answer("market").includes(`${economyCatalog.market.showcaseRefreshSeconds / 60} минут`));
  assert.match(answer("rewards"), /Открытие окна ничего не начисляет/);
  assert.match(answer("rewards"), /пропуск не сбрасывает шаг/);
});

test("profile guidance distinguishes mood, food, friends and future profile links", () => {
  assert.match(answer("level"), /«Профиль».*«Настроение».*«Друзья»/);
  assert.match(answer("mochlik-life"), /офлайн силы не расходуются/);
  assert.match(answer("mochlik-life"), /Настроение не заменяет сытость/);
  assert.match(answer("friend-profile"), /Карточки новой вкладки пока не открывают чужой профиль/);
  assert.match(answer("friend-profile"), /если разрешена видимость/);
  assert.match(answer("friend-profile"), /Кошелёк, запасы и задания остаются личными/);
  assert.match(answer("future-world"), /ещё готовятся/);
  assert.doesNotMatch(answer("friend-profile"), /онлайн|последний вход|чужие запасы/);
});
