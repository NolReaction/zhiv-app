# Рабочее состояние - work/0.7.1

## Лавка, продажи на карте и экономика v12

2026-10-19. Продолжение 020585a (ручная выручка рынка, V63). Дима попросил открывать свою лавку, уведомлять о продаже над рынком, продавать реликвии за жемчуг, убрать четыре страницы коллекции с восьмичасовой работы, менять ассортимент Листохвоста и покупать припасы поштучно. Публикация разрешена; master, earth, деплой и production DB вне задачи. Изначально дерево чистое.

- Рынок открывается «Моя лавка». Над крышей плашка «Продано» с количеством незабранных продаж, нажатие ведёт к своей лавке. Использует существующий MapFeedback/anchorStore, не тяжёлую проекцию карты. Только owned sold pending из подтверждённого своего market; фоновые запросы раз30s только active/visible/online, cleanup при hidden/suspended/account/unmount; гостям нет.
- Каталог v12. Листохвост: два предмета одежды, по одной удочке/крючку/наживке, три припаса, один или два вида реликвий. Персональный hash-ring + дневное смещение, одинаковое TS/Kotlin; соседняя поставка меняет пары одежды и тройки припасов. Покупка/owned не перебрасывает выбор. Сутки00:00UTC/03:00МСК.
- Ядро/кристалл/смола одинаково150видимых=300raw жемчужин,1stock/вид. Free drops/бартер/проектные гарантии/седьмой подарок сохранены. Недельные подарки500видимых позволяют3реликвии+50остаток. 100обучение/100welcome-mail/1500достижения разовые. Ускорение НЕ фиксированные минуты:1м1/1ч20/6ч73/24ч260/48ч384/7д1000; кривая сохранена. Платежи не активируются.
- Новые supplyOffers/pearlOffers, старые массивы читаются для старых снимков; реликвии убраны из coin offers. Восемь припасов, новые *_each ID, stock5..20, unitprice>=2×baseSellPrice. quantity1..20, выбранная сумма/валюта/остаток/кладовая валидируются сервером. v2:<cycle>:id защищает от старых монетных запросов. Старые подтверждённые квитанции воспроизводятся без покупки. purchased хранит единицы<=100; native merge складывает расход той же поставки. SQL-миграция не нужна, схема остаётсяV63, web/API обновляются вместе.
- Личная книга отдельно от расходуемых реликвий: работы catalogVersion>=12 учитывают максимум2hлеса/4hшахты и максимум1новую страницу. Короткие работы суммируются; лишние часы не переносятся. Старые оплаченные jobs<=11 завершаются по прежним правилам; finds/remainders сохраняются. Рыба открывается только своим уловом, покупка не открывает вид.
- Лавка показывает оба кошелька, выбор количества, точный чек по валюте, доступный остаток, реальные пустые поставки; раздел «Реликвии» отличает ресурсы от книги. Предпросмотр валюты показывает три ценовых ориентира из каталога (реликвия/второе место/час стройки), без платёжных действий. Справка и тематические документы обновлены.

## Проверено и что осталось

- Map/UI целевые84/84 и actualWorldView+DEV browser8/8,320/390/1280 безoverflow/JSerrors, плашка→лавка→claim→плашкаисчезла. Логи /tmp/zhiv-market-world-badge-tests.log, /tmp/zhiv-world-market-badge-qa.
- Collection actualDEV/UI/achievements/actor43/43, старые/new jobs/cancel/replay/storage; root51/51 help/currency/mining, guard audit-economy-progression теперь12. Trader existing119/119, новый v2domain13/13, новыйUI6/6; независимые наборы с пересечениями, не суммировать вслепую. Логи /tmp/zhiv-trader-*.log, /tmp/zhiv-collection-core-final.log, /tmp/zhiv-leaftail-delivery-v2.log.
- Full typecheck, ESLint, финальный scoped lint, architecture880modules и world/audio check прошли. Финальные Sites и VPS builds прошли последовательно после всех правок. У VPS пришлось очистить повреждённый generated Turbopack cache (invalid digit в persistence), после этого сборка exit0. Все исходники frozen. Tracked securityscan findings0, diffcheckgreen.
- Trader actualRadixDialog +useEconomy+realDEV browser13/13green:qty3/debit/stock, relic150visible/raw300, doubletap, lostACK/reload, owned, owner/dayrotation, обаwallet,3shopbenchmarks.320/390/1280 безoverflow/JSerrors, финальные3скриншота просмотрены; CSSкнопки исправлен. Браузеры/серверы остановлены. Лог /tmp/zhiv-trader-browser-qa/run-dialog-final.log. Nativeвсеmain/testKotlin скомпилированы;40unitpassed,0failures/errors,9PGskippedлокальнобезDocker. Лог /tmp/zhiv-trader-v12-native-verified.log. Исходники заморожены.
- CI market-sales расширен: старые manualclaims/Marketrules + JdbcLeaftailV12IntegrationTest, JdbcCollectionV12IntegrationTest, LeaftailShop/Assortment/BookProgression/FourthStage. Нужен реальный PG в GitHub после публикации; local skipped не passed.

## Следующий шаг

Все локальные проверки и freeze готовы. Опубликовать обычным коммитом work/0.7.1 через Git Data (text batches, expectedparent, forcefalse, полное совпадение tree SHA). Затем дождаться focused CI с реальной PostgreSQL и исправить новые ошибки, если есть. Не запускать deploy/master/reset.

Предыдущие17проверок ручной выручки были зелёные на8f610c1; общий старый CI имеет5посторонних mail/reset/fishing failures и history-size-limit art/earth/models/eiffel-tower/source.glb. Earth не менять. Подробности предыдущего этапа: 020585a:WORK_STATE.md.
