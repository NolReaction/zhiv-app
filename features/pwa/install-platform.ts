export type InstallPlatform = "ios" | "android" | "mac" | "windows" | "linux" | "unknown";
export type InstallBrowser = "safari" | "chrome" | "edge" | "firefox" | "samsung" | "yandex" | "other";
export type InstallEnvironment = {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  clientHints?: { platform?: string; brands?: readonly { brand: string }[] };
};
export type InstallDevice = { platform: InstallPlatform; browser: InstallBrowser; embedded: boolean };

export const UNKNOWN_INSTALL_DEVICE: InstallDevice = { platform: "unknown", browser: "other", embedded: false };

/** Detection selects help text, never grants capabilities or proves installation. */
export function detectInstallDevice(input: InstallEnvironment): InstallDevice {
  const ua = input.userAgent;
  const hintedPlatform = input.clientHints?.platform ?? "";
  const brands = input.clientHints?.brands?.map(item => item.brand).join(" ") ?? "";
  // iPad's desktop UA identifies as a Mac. Keep its touch fallback ahead of
  // platform hints; hints are never proof of installation or capabilities.
  const platform: InstallPlatform = /iPhone|iPad|iPod/i.test(ua) || input.platform === "MacIntel" && input.maxTouchPoints > 1
    ? "ios" : /Android/i.test(hintedPlatform) ? "android" : /Windows/i.test(hintedPlatform) ? "windows"
      : /macOS/i.test(hintedPlatform) ? "mac" : /Linux|Chrome OS/i.test(hintedPlatform) ? "linux"
        : /Android/i.test(ua) ? "android" : /Mac/i.test(ua + input.platform) ? "mac" : /Windows|Win32|Win64/i.test(ua + input.platform) ? "windows" : /Linux/i.test(ua + input.platform) ? "linux" : "unknown";
  // Named products beat Chromium's shared compatibility UA and hint order.
  const browser: InstallBrowser = /YaBrowser|YaSearchBrowser/i.test(ua) ? "yandex"
    : /SamsungBrowser/i.test(ua) ? "samsung"
      : /Edg(?:e|A|iOS)?\//i.test(ua) ? "edge"
        : /Firefox|FxiOS/i.test(ua) ? "firefox"
          : /OPR\/|Opera|OPT\/|Vivaldi\//i.test(ua) ? "other"
            : /Yandex/i.test(brands) ? "yandex" : /Samsung/i.test(brands) ? "samsung"
              : /Microsoft Edge/i.test(brands) ? "edge" : /Firefox/i.test(brands) ? "firefox"
                : /Brave|Opera|Vivaldi/i.test(brands) ? "other" : /Google Chrome/i.test(brands) ? "chrome"
                  : /Chrome|CriOS/i.test(ua) ? "chrome" : /Safari/i.test(ua) ? "safari" : "other";
  const embedded = /(?:; wv\)|\bwv\b|FBAN|FBAV|Instagram|Telegram|VKClient|VKApp|Line\/|MicroMessenger|GSA\/)/i.test(ua)
    || platform === "ios" && /AppleWebKit/i.test(ua) && !/Safari|CriOS|FxiOS|EdgiOS|YaBrowser|OPT\//i.test(ua);
  return { platform, browser, embedded };
}

const PLATFORM_LABELS: Record<InstallPlatform, string> = {
  ios: "iPhone / iPad", android: "Android", mac: "Mac", windows: "Windows", linux: "Linux", unknown: "",
};
const BROWSER_LABELS: Record<InstallBrowser, string> = {
  safari: "Safari", chrome: "Chrome", edge: "Edge", firefox: "Firefox", samsung: "Samsung Internet", yandex: "Яндекс Браузер", other: "",
};

export function installDeviceLabel(device: InstallDevice): string {
  if (device.embedded) return "Встроенный браузер";
  return [BROWSER_LABELS[device.browser], PLATFORM_LABELS[device.platform]].filter(Boolean).join(" · ") || "Браузер не определён";
}

export type InstallGuide = { title: string; actions: readonly [string, string, string]; steps: readonly string[]; note: string };
export type InstallGuideId = "ios" | "android-chrome" | "android-samsung" | "android-firefox" | "android-yandex" | "desktop-chrome" | "desktop-edge" | "mac-safari" | "windows-firefox" | "other";

export const INSTALL_GUIDE_OPTIONS: readonly { id: InstallGuideId; label: string }[] = [
  { id: "ios", label: "iPhone / iPad · Safari" },
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
    if (device.browser === "chrome") return "android-chrome";
    return "other";
  }
  if (device.platform === "unknown") return "other";
  if (device.platform === "mac" && device.browser === "safari") return "mac-safari";
  if (device.browser === "edge") return "desktop-edge";
  if (device.browser === "firefox" && device.platform === "windows") return "windows-firefox";
  if (device.browser === "chrome") return "desktop-chrome";
  return "other";
}

export const INSTALL_GUIDES: Record<InstallGuideId, InstallGuide> = {
  ios: {
    title: "Три шага в Safari",
    actions: ["Поделиться", "На экран «Домой»", "Открыть приложение"],
    steps: ["Нажмите «Поделиться». В новом Safari эта кнопка может находиться в меню страницы.", "Выберите «На экран „Домой“». Если есть «Открывать как веб-приложение», включите его и нажмите «Добавить».", "Закройте вкладку и откройте «Я живой» со значка на экране «Домой»."],
    note: "Нет нужного пункта? Прокрутите меню «Поделиться» до «Редактировать действия» и добавьте его. Уведомления доступны с iOS / iPadOS 16.4.",
  },
  "android-chrome": {
    title: "Три шага в Chrome",
    actions: ["Меню браузера", "Установить", "Открыть приложение"],
    steps: ["Нажмите меню ⋮ рядом с адресной строкой Chrome.", "Выберите «Установить и создать ярлык» → «Установить». Пункт также может называться «Установить приложение» или «Добавить на главный экран».", "Подтвердите установку и откройте «Я живой» с появившегося значка."],
    note: "Названия пунктов зависят от версии браузера. Если доступен только обычный ярлык и он открывает вкладку, попробуйте обновить Chrome.",
  },
  "android-samsung": {
    title: "Установка в Samsung Internet",
    actions: ["Значок установки", "Добавить", "Открыть приложение"],
    steps: ["Найдите значок установки рядом с адресной строкой Samsung Internet.", "Нажмите его и подтвердите добавление на экран приложений.", "Запустите «Я живой» с появившегося значка."],
    note: "Если значка установки нет, откройте этот же адрес в Chrome и выберите инструкцию для Android · Chrome.",
  },
  "android-firefox": {
    title: "Установка в Firefox на Android",
    actions: ["Меню браузера", "Установить", "Открыть приложение"],
    steps: ["Откройте меню ⋮ в Firefox.", "Нажмите «Установить», затем подтвердите добавление значка на главный экран.", "Откройте «Я живой» с главного экрана."],
    note: "На некоторых устройствах нужно дополнительно нажать «Добавить автоматически».",
  },
  "android-yandex": {
    title: "Продолжите установку в Chrome",
    actions: ["Скопировать адрес", "Открыть Chrome", "Установить"],
    steps: ["Скопируйте адрес кнопкой ниже.", "Вставьте его в адресную строку Chrome на этом устройстве.", "На открывшемся сайте нажмите кнопку установки или выберите «Установить приложение» в меню ⋮."],
    note: "Пункт Яндекс Браузера «Добавить ярлык» может открывать обычную вкладку: такой ярлык не гарантирует запуск приложения в отдельном окне.",
  },
  "desktop-chrome": {
    title: "Отдельное приложение на компьютере",
    actions: ["Значок установки", "Меню, если значка нет", "Открыть приложение"],
    steps: ["Нажмите значок установки справа в адресной строке Chrome.", "Если значка нет: меню ⋮ → «Транслировать, сохранить, поделиться» → «Установить страницу как приложение».", "Подтвердите установку. Запускайте «Я живой» из списка приложений или закрепите его на панели задач."],
    note: "Если пункт отсутствует, обновите браузер или используйте Edge. В приватном режиме установка может быть недоступна.",
  },
  "desktop-edge": {
    title: "Установка через Microsoft Edge",
    actions: ["Меню браузера", "Установить", "Открыть приложение"],
    steps: ["Откройте меню ⋯ в Edge.", "Выберите «Дополнительные инструменты» → «Приложения» → «Установить этот сайт как приложение». В некоторых версиях «Приложения» находятся сразу в меню.", "Подтвердите установку и запустите «Я живой» из списка приложений."],
    note: "Можно также использовать значок установки в адресной строке, если он доступен.",
  },
  "mac-safari": {
    title: "Добавление в Dock на Mac",
    actions: ["Поделиться", "Добавить в Dock", "Открыть приложение"],
    steps: ["В Safari откройте «Поделиться» или меню «Файл».", "Выберите «Добавить в Dock» и нажмите «Добавить».", "Запускайте «Я живой» со значка в Dock или из папки «Программы»."],
    note: "Нужна macOS Sonoma 14 или новее. На более ранней macOS установите приложение через Chrome или Edge.",
  },
  "windows-firefox": {
    title: "Приложение в Firefox на Windows",
    actions: ["Кнопка веб-приложения", "Добавить", "Открыть приложение"],
    steps: ["В обновлённом Firefox на Windows найдите кнопку веб-приложения справа в адресной строке.", "Добавьте сайт как веб-приложение и подтвердите действие.", "Запускайте «Я живой» через меню «Пуск» или панель задач."],
    note: "Доступно с Firefox 143 на Windows, для версии из Microsoft Store — с 150. На macOS / Linux или без этой кнопки используйте Chrome либо Edge.",
  },
  other: {
    title: "Подберём способ установки",
    actions: ["Ваше устройство", "Подходящий браузер", "Установить"],
    steps: ["Откройте «Другой браузер или устройство» и выберите подходящий вариант.", "На iPhone / iPad используйте Safari, на Android — Chrome. На компьютере подойдут Chrome, Edge или Safari на macOS 14 и новее.", "Следуйте выбранной инструкции и запускайте приложение с появившегося значка."],
    note: "Браузер передал недостаточно сведений для точной инструкции. Ручной выбор всегда доступен; можно также продолжить в браузере.",
  },
};

/** Automatic iOS help names the browser in use instead of mixing its menus. */
export function installGuideForDevice(device: InstallDevice): InstallGuide {
  const suggested = suggestedInstallGuide(device);
  const guide = INSTALL_GUIDES[suggested];
  if (suggested === "other" && device.platform !== "unknown") return {
    ...INSTALL_GUIDES["android-yandex"],
    note: "У этого браузера не определён способ установки. Откройте сайт в Chrome — там мы покажем подходящую инструкцию.",
  };
  if (device.platform !== "ios" || device.browser === "safari") return guide;
  if (device.browser === "chrome") return {
    ...INSTALL_GUIDES.ios, title: "Три шага в Chrome",
    actions: ["Поделиться", "На главный экран", "Открыть приложение"],
    steps: ["Нажмите «Поделиться» справа от адресной строки Chrome.", "Выберите «Добавить на главный экран» и подтвердите кнопкой «Добавить».", "Закройте вкладку и откройте «Я живой» с появившегося значка."],
    note: "Если значок открывает обычную вкладку, добавьте сайт через Safari и включите «Открывать как веб-приложение», если переключатель доступен.",
  };
  return {
    ...INSTALL_GUIDES.ios, title: "Продолжите установку в Safari",
    actions: ["Скопировать адрес", "Открыть Safari", "На экран «Домой»"],
    steps: ["Скопируйте адрес сайта кнопкой ниже.", "Откройте Safari и вставьте адрес в его адресную строку.", "Нажмите «Поделиться» → «На экран „Домой“» → «Добавить». Затем запустите приложение со значка."],
    note: "Safari предлагает системный способ установки на iPhone и iPad. Если есть переключатель «Открывать как веб-приложение», включите его.",
  };
}

/** Existing auth, invitation and push links must reach their current handlers untouched. */
export function hasApplicationEntryLink(location: { pathname: string; search: string; hash: string }): boolean {
  if (location.pathname !== "/") return false;
  const query = new URLSearchParams(location.search);
  return query.has("auth") || query.has("notification") || query.has("_appBuild")
    || /^#\/(?:invite|recover)\//.test(location.hash);
}
