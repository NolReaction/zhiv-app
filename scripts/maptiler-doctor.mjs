import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import nextEnv from "@next/env";

const KEY = "NEXT_PUBLIC_MAPTILER_KEY";

/** Use Next's real DEV loader. Return status only; never expose env values. */
export function diagnoseMaptiler(projectRoot = process.cwd()) {
  const terminalOverride = Object.hasOwn(process.env, KEY);
  const warnings = [];
  const localFile = resolve(projectRoot, ".env.local");
  if (existsSync(`${localFile}.txt`)) warnings.push("Найден .env.local.txt: уберите расширение .txt.");
  if (existsSync(localFile)) {
    const bytes = readFileSync(localFile);
    if (bytes.includes(0) || (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
      warnings.push(".env.local записан в UTF-16: сохраните его как обычный текст UTF-8.");
    }
  }
  let loadError = false;
  const { combinedEnv, loadedEnvFiles } = nextEnv.loadEnvConfig(projectRoot, true, {
    info() {}, error() { loadError = true; },
  }, true);
  const value = (combinedEnv[KEY] ?? "").trim();
  const valid = /^[A-Za-z0-9_-]{1,200}$/.test(value);
  const sourceFile = loadedEnvFiles.find(file => Object.hasOwn(file.env, KEY));
  const source = terminalOverride ? "переменная терминала" : sourceFile?.path ?? "не найден";
  if (terminalOverride && !value) warnings.push("Пустая переменная терминала перекрывает значение из файла.");
  if (loadError) warnings.push("Next не смог прочитать один из env-файлов. Проверьте доступ к файлам.");
  if (!value) {
    const aliases = ["MAPTILER_KEY", "VITE_MAPTILER_KEY", "NEXT_PUBLIC_MAPTILER_API_KEY"];
    if (aliases.some(name => loadedEnvFiles.some(file => Object.hasOwn(file.env, name)))) {
      warnings.push(`Использовано другое имя переменной. Нужно ровно ${KEY}.`);
    }
  }
  return {
    projectRoot: resolve(projectRoot),
    localFileExists: existsSync(localFile),
    loadedFiles: loadedEnvFiles.map(file => file.path),
    source,
    status: !value ? "missing" : valid ? "ready" : "invalid",
    warnings,
  };
}

export function formatMaptilerDiagnosis(result) {
  const labels = {
    ready: "ключ прочитан, формат допустим",
    missing: "ключ отсутствует или пуст",
    invalid: "неверный формат: вставьте только ключ, без URL и названия переменной",
  };
  return [
    `Папка проекта: ${result.projectRoot}`,
    `.env.local: ${result.localFileExists ? "найден" : "не найден"}`,
    `Next DEV прочитал: ${result.loadedFiles.join(", ") || "env-файлов нет"}`,
    `Источник ${KEY}: ${result.source}`,
    `MapTiler: ${labels[result.status]}`,
    ...result.warnings,
    ...(result.status === "ready" ? [
      "Это проверка настройки на диске; ключ и запросы MapTiler не выводятся.",
      "Если карта всё ещё пишет «не подключён», сравните папку проекта с папкой запуска сервера и адресом открытой вкладки.",
    ] : [`В .env.local рядом с package.json должна быть строка ${KEY}=ваш_ключ`]),
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // The actual dev:local launcher also forces development regardless of shell NODE_ENV.
  process.env.NODE_ENV = "development";
  try {
    const result = diagnoseMaptiler();
    console.log(formatMaptilerDiagnosis(result));
    process.exitCode = result.status === "ready" ? 0 : 1;
  } catch {
    console.error("Не удалось проверить настройку MapTiler. Проверьте доступ к папке проекта и env-файлам.");
    process.exitCode = 1;
  }
}
