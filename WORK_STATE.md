# Рабочее состояние - work/0.7.1

## Общий рынок, витрина 5 минут и звук торговли

2026-10-19. Дима попросил звук торговли и приглушение музыки в своём рынке как у друга, обновление витрины раз в 5 минут и решение для малого онлайна. Продолжение `fa2253aaac0167f9db87d77efbc09edf9d88a144`. Публикация рабочей ветки разрешена; master, earth, деплой и production DB вне задачи. Рабочая копия восстановлена из GitHub после очистки scratch; пользовательских локальных изменений не было.

- Денежный рынок объединяет дома 2–5 в TS/DEV/Ktor, включая лавки друзей. Общий helper marketCanTrade/canTrade, диапазон витрины 2..5. Покупатель по-прежнему получает только лично открытые товары; открытие рынка, цена, монеты, место, revision, комиссия, суточный объём и приватность сохраняются.
- Каталог и defaults: market.showcaseRefreshSeconds=300. Сохранённая прежняя lease со сроком дальше now+300s перестраивается при чтении и отклоняется при покупке без повторного списания. TTL не продлевается каждым GET. Бартер сохраняет прежние отдельные правила, его helpers отделены от денежного рынка.
- Свой рынок и лавка друга используют общие музыкальные ключи с duck0.3 и одним коротким оригинальным ui.market-open (мешочек/монеты,0.82s,WAV78764bytes). Новая постоянная петля не добавлена, мобильный бюджет не увеличен. Покупки уже озвучивает общий receipt tracker.
- audioSuppressed выключает только звуковой кадр собственной сцены за рынком; симуляция продолжает работать. Скрытая вкладка/пауза освобождают микс, возврат не повторяет монетки; mute/громкость/очистка владельца сохраняются. Гостевая карта оставляет существующую паузу за лавкой.
- DEV/справка/документация убрали обещание групп2–3/4–5. Исторический аудит рынка помечен поправкой от19октября; текущая основа экономики и friend-profiles обновлены.
- Заодно закрыта регрессия fa2253a: removeDevEconomyOwner по умолчанию сохраняет дневную историю при сбросе; удаление помеченного бота явно передаёт deleteHistory=true. Лимит другого владельца не затрагивается.

## Проверки и следующий шаг

- Целевые экономические TS/DEV/session tests76/76, UI/справка/devbots46/46, audio controller/runtime/originals/menu/world149/149. Это разные наборы. audio:check:53cues,112ready,0pending. Scoped lint source/tests и полный ESLint прошли. Лог `/tmp/zhiv-market-lint.log`.
- Typecheck, architecture-check875modules и world:check прошли. Финальные Sites и VPS builds прошли последовательно после всех исходников; VPS также проверил TypeScript. Логи `/tmp/zhiv-market-{sites,vps}-build.log`.
- Browser QA:18/18 сценариев, JS errors=[],320/390/1280 без overflow. Настоящие WorldView/GuestWorldVisit/WebAudio: gain .03 при music .1, один AudioContext, без повторного musicStarts на handoff, одна подпись открытия, mute/volume/hidden/suspend/account/offline cleanup; видимый таймер05:00. Гостевой API в browser fixture, точный вызов cross-home покупки проверен; реальные списания покрыты DEV tests. Лог `/tmp/zhiv-market-audio-qa/run.log`. Browser/server остановлены.
- Native JDK25/Gradle9.6.0 восстановлены в /tmp/market-java. Все main/test Kotlin скомпилированы,16/16 Market/Barter/Guest rules+HTTP tests прошли. 45 PostgreSQL integration tests пропущены локально без Docker; изменённые SQL/assertions проверит CI, не выдавать их за локально пройденные. Лог `/tmp/zhiv-market-kotlin-tests.log`.
- Tracked security scan findings=0, diffcheck прошёл. Публикация обычным коммитом work/0.7.1 через Git Data: text tree batches + WAV create_blob(base64), проверка конечного tree SHA, expectedparent/forcefalse. Для запуска изменений обновлять веб и API вместе; миграций нет. Master/deploy/production DB не затронуты.

## Предыдущий этап и известные ограничения

- DEV-боты опубликованы `fa2253a`, настоящие визиты/покупки `3824741`, API `5116b58`/`00f70bb`; прежние7новыхPGtests прошли CI39178610876.
- Прежний полный npm test:5961tests,5952passed,9старыхfailures; backend937tests,930passed,7старыхfailures. Полный долгий webнабор на этом этапе пока не запускался; не выдавать прежние проверки за проверки текущего коммита.
- У прежнего CI history scan был size limit чужого art/earth/models/eiffel-tower/source.glb. Это отдельная ветка, не менять её в этой задаче.
- Предыдущие подробности: `fa2253a:WORK_STATE.md`, `3824741:WORK_STATE.md`.
