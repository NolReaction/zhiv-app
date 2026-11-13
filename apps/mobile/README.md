# Мохлик · Тест

Полный общий React-клиент Мохлика в Capacitor для iPhone и Android. Нативные вход/API/хранилище, геопозиция, локальные уведомления, lifecycle, сеть, safe areas, память, вибрация и sharing. Лаборатория остаётся доступна из настроек устройства.

**Для входа требуется web/API этой ветки на сервере.** Старый сервер не содержит `/mobile/connect` и мобильного PKCE-обмена. Развёртывание не выполняется командами сборки клиента.

Из корня репозитория:

```bash
npm ci
npm run mobile:sync
npm run mobile:ios
# или
npm run mobile:android
```

Origin по умолчанию: `https://im-alive.ru`. Другой HTTPS origin задаётся `VITE_MOBILE_API_ORIGIN` перед сборкой; публичный ключ внешних карт — `NEXT_PUBLIC_MAPTILER_KEY`. `mobile:build` записывает origin в нативные проекты, `mobile:sync` переносит bundle и плагины. После изменений повторить sync и сборку в IDE. Signing team остаётся локальной настройкой разработчика.

`mobile:dev` не подменяет нативные модули браузерными имитациями. Автоматические проверки: `npm run test:mobile`, `npm run typecheck`, `npm run architecture:check`, `npm run lint`; нативные сборки и проверки — `.github/workflows/mobile.yml`.

[Подробная инструкция, точное покрытие и матрица устройств](../../docs/development/native-mobile.md).

Границы: часть локальных игровых журналов пока остаётся в WebView; SQLite покрывает передаваемые экономические команды. Локальные напоминания не заменяют APNs/FCM push. Работа после принудительного закрытия не обещается. Физические iPhone/Android и батарея требуют ручной проверки новой версии.
