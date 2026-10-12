export type InstallPlatform = "ios" | "android" | "mac" | "windows" | "linux" | "unknown";
export type InstallBrowser = "safari" | "chrome" | "edge" | "firefox" | "samsung" | "yandex" | "other";
export type InstallEnvironment = {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
};
export type InstallDevice = { platform: InstallPlatform; browser: InstallBrowser; embedded: boolean };

export const UNKNOWN_INSTALL_DEVICE: InstallDevice = { platform: "unknown", browser: "other", embedded: false };

/** Detection selects help text, never grants capabilities or proves installation. */
export function detectInstallDevice(input: InstallEnvironment): InstallDevice {
  const ua = input.userAgent;
  const platform: InstallPlatform = /iPhone|iPad|iPod/i.test(ua) || input.platform === "MacIntel" && input.maxTouchPoints > 1
    ? "ios" : /Android/i.test(ua) ? "android" : /Mac/i.test(ua) ? "mac" : /Windows/i.test(ua) ? "windows" : /Linux/i.test(ua) ? "linux" : "unknown";
  const browser: InstallBrowser = /YaBrowser|YaSearchBrowser/i.test(ua) ? "yandex"
    : /SamsungBrowser/i.test(ua) ? "samsung"
      : /Edg(?:e|A|iOS)?\//i.test(ua) ? "edge"
        : /Firefox|FxiOS/i.test(ua) ? "firefox"
          : /OPR\/|Opera|OPT\//i.test(ua) ? "other"
          : /Chrome|CriOS/i.test(ua) ? "chrome"
            : /Safari/i.test(ua) ? "safari" : "other";
  const embedded = /(?:; wv\)|\bwv\b|FBAN|FBAV|Instagram|Telegram|VKClient|VKApp|Line\/)/i.test(ua);
  return { platform, browser, embedded };
}

export type InstallGuide = { title: string; steps: readonly string[]; note: string };
export type InstallGuideId = "ios" | "android-chrome" | "android-samsung" | "android-firefox" | "android-yandex" | "desktop-chrome" | "desktop-edge" | "mac-safari" | "windows-firefox" | "other";

export const INSTALL_GUIDE_OPTIONS: readonly { id: InstallGuideId; label: string }[] = [
  { id: "ios", label: "iPhone / iPad" },
  { id: "android-chrome", label: "Android · Chrome" },
  { id: "android-samsung", label: "Android · Samsung Internet" },
  { id: "android-firefox", label: "Android · Firefox" },
  { id: "android-yandex", label: "Android · Яндекс Браузер" },
  { id: "desktop-chrome", label: "Компьютер · Chrome" },
  { id: "desktop-edge", label: "Компьютер · Edge" },
  { id: "mac-safari", label: "Mac · Safari" },
  { id: "windows-firefox", label: "Windows · Firefox" },
  { id: "other", label: "Другой браузер" },
];

export function suggestedInstallGuide(device: InstallDevice): InstallGuideId {
  if (device.platform === "ios") return "ios";
  if (device.platform === "android") {
    if (device.browser === "samsung") return "android-samsung";
    if (device.browser === "firefox") return "android-firefox";
    if (device.browser === "yandex") return "android-yandex";
    return "android-chrome";
  }
  if (device.platform === "mac" && device.browser === "safari") return "mac-safari";
  if (device.browser === "edge") return "desktop-edge";
  if (device.browser === "firefox" && device.platform === "windows") return "windows-firefox";
  if (device.browser === "chrome") return "desktop-chrome";
  return "other";
}

export const INSTALL_GUIDES: Record<InstallGuideId, InstallGuide> = {
  ios: {
    title: "На экран «Домой»",
    steps: ["Откройте меню «Поделиться» в Safari или Chrome. В Safari оно может находиться внутри меню страницы или «Ещё».", "Выберите «На экран „Домой“» (в Chrome — «Добавить на главный экран»). Если есть переключатель «Открывать как веб-приложение», включите его.", "Нажмите «Добавить», затем запустите «Я живой» со значка на экране «Домой»."],
    note: "Не нашли пункт? Откройте этот адрес в Safari. Для уведомлений в установленном приложении нужна iOS / iPadOS 16.4 или новее.",
  },
  "android-chrome": {
    title: "Установка на Android",
    steps: ["Откройте сайт в Chrome и нажмите меню ⋮ возле адресной строки.", "Выберите «Установить и создать ярлык» → «Установить». В других версиях пункт называется «Установить приложение» или «Добавить на главный экран».", "Подтвердите установку. Когда появится значок «Я живой», откройте приложение с него."],
    note: "Названия пунктов зависят от версии браузера. Если доступен только обычный ярлык и он открывает вкладку, попробуйте обновить Chrome.",
  },
  "android-samsung": {
    title: "Установка в Samsung Internet",
    steps: ["Откройте сайт в Samsung Internet.", "Нажмите значок установки рядом с адресной строкой и подтвердите добавление на экран приложений.", "Запустите «Я живой» с появившегося значка."],
    note: "Если значка установки нет, откройте этот же адрес в Chrome и выберите инструкцию для Android · Chrome.",
  },
  "android-firefox": {
    title: "Установка в Firefox на Android",
    steps: ["Откройте меню ⋮ в Firefox.", "Нажмите «Установить», затем подтвердите добавление значка на главный экран.", "Откройте «Я живой» с главного экрана."],
    note: "На некоторых устройствах нужно дополнительно нажать «Добавить автоматически».",
  },
  "android-yandex": {
    title: "Яндекс Браузер на Android",
    steps: ["Если выше доступна кнопка «Установить приложение», нажмите её и подтвердите установку.", "Если кнопки нет, скопируйте адрес сайта и откройте его в Chrome.", "Выберите здесь «Android · Chrome», установите приложение и запустите его со значка."],
    note: "Пункт Яндекс Браузера «Добавить ярлык» может открывать обычную вкладку: такой ярлык не гарантирует запуск приложения в отдельном окне.",
  },
  "desktop-chrome": {
    title: "Отдельное приложение на компьютере",
    steps: ["Нажмите значок установки справа в адресной строке Chrome.", "Если значка нет: меню ⋮ → «Транслировать, сохранить, поделиться» → «Установить страницу как приложение».", "Подтвердите установку. Запускайте «Я живой» из списка приложений или закрепите его на панели задач."],
    note: "Если пункт отсутствует, обновите браузер или используйте Edge. В приватном режиме установка может быть недоступна.",
  },
  "desktop-edge": {
    title: "Установка через Microsoft Edge",
    steps: ["Откройте меню ⋯ в Edge.", "Выберите «Дополнительные инструменты» → «Приложения» → «Установить этот сайт как приложение». В некоторых версиях «Приложения» находятся сразу в меню.", "Подтвердите установку и запустите «Я живой» из списка приложений."],
    note: "Можно также использовать значок установки в адресной строке, если он доступен.",
  },
  "mac-safari": {
    title: "Добавление в Dock на Mac",
    steps: ["В Safari откройте «Поделиться» или меню «Файл».", "Выберите «Добавить в Dock» и нажмите «Добавить».", "Запускайте «Я живой» со значка в Dock или из папки «Программы»."],
    note: "Нужна macOS Sonoma 14 или новее. На более ранней macOS установите приложение через Chrome или Edge.",
  },
  "windows-firefox": {
    title: "Приложение в Firefox на Windows",
    steps: ["В обновлённом Firefox на Windows найдите кнопку веб-приложения справа в адресной строке.", "Добавьте сайт как веб-приложение и подтвердите действие.", "Запускайте «Я живой» через меню «Пуск» или панель задач."],
    note: "Доступно с Firefox 143 на Windows, для версии из Microsoft Store — с 150. На macOS / Linux или без этой кнопки используйте Chrome либо Edge.",
  },
  other: {
    title: "Выберите подходящий способ",
    steps: ["На iPhone и iPad откройте сайт в Safari; на Android — в Chrome.", "На компьютере используйте Chrome, Edge или Safari на macOS Sonoma 14 и новее.", "Выберите своё устройство в списке выше и выполните шаги установки."],
    note: "Пока установка недоступна, можно продолжить в браузере. Учётная запись и серверный прогресс остаются доступны после входа.",
  },
};

/** Existing auth, invitation and push links must reach their current handlers untouched. */
export function hasApplicationEntryLink(location: { pathname: string; search: string; hash: string }): boolean {
  if (location.pathname !== "/") return false;
  const query = new URLSearchParams(location.search);
  return query.has("auth") || query.has("notification") || query.has("_appBuild")
    || /^#\/(?:invite|recover)\//.test(location.hash);
}
