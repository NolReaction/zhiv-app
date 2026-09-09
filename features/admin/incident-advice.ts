/** Fixed, credential-free guidance shared by admin incident cards. */
export function incidentAdvice(code: string) {
  if (code.startsWith("WORLD_MAP_") || code.startsWith("WORLD_CHARACTER_")) return "Проверьте доступность файлов карты и персонажа. API может работать, даже если изображения не загрузились. Повтор загрузки не изменяет прогресс.";
  if (["NETWORK_ERROR", "TIMEOUT", "OFFLINE"].includes(code)) return "Сравните время события и получения: запись могла прийти после восстановления связи. Проверьте другие события игрока в этот период.";
  if (code === "RATE_LIMITED") return "Сравните всплеск 429 на вкладке «Сервер» с частотой запросов этого игрока. Единичное ограничение не означает отказ API.";
  if (code === "GAME_ACTIVE_ELSEWHERE") return "Проверьте, не открыта ли игра на другом устройстве. Само событие не означает потерю очков.";
  if (["STORAGE_FAILED", "QUEUE_FULL"].includes(code)) return "Не очищайте данные браузера до проверки очереди: там могут оставаться неподтверждённые нажатия.";
  if (["GAME_SEQUENCE_CONFLICT", "RECEIPT_INVALID", "GAME_SESSION_GONE"].includes(code)) return "Сохраните номер запроса и проверьте подтверждения API. Не переносите очередь в новую игровую сессию вручную.";
  if (code === "GAME_QUEUE_EXPIRED") return "Нужна отдельная проверка сохранённой очереди: сервер не подтвердил её доставку в срок.";
  if (["DATABASE_BUSY", "INTERNAL_ERROR", "SERVER_ERROR"].includes(code)) return "Найдите номер запроса в журнале API; проверьте ошибки 5xx, задержки и состояние базы данных.";
  if (code === "SYNC_RECOVERED") return "Отправка возобновилась. Это ещё не подтверждение сохранения всей очереди нажатий.";
  if (["PAGE_ERROR", "UNHANDLED_REJECTION"].includes(code)) return "Для воспроизведения нужны экран, действие и версия приложения. Сопоставьте время с обновлениями приложения.";
  return "Сохраните код события, время и номер запроса. Сопоставьте с соседними событиями игрока и журналом API.";
}
