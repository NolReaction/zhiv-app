export function dataFreshnessMessage({ updatedAt, nowMs, isOnline, failed, loading }: {
  updatedAt: number | null;
  nowMs: number;
  isOnline: boolean;
  failed: boolean;
  loading: boolean;
}): string {
  const time = updatedAt === null ? null : new Date(updatedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (!isOnline) return time ? `Нет интернета · данные от ${time}` : "Нет интернета · данные ещё не загружены";
  if (loading) return time ? `Обновляем · данные от ${time}` : "Загружаем данные…";
  if (failed) return time ? `Не удалось обновить · данные от ${time}` : "Не удалось загрузить данные";
  if (updatedAt === null) return "Данные ещё не загружены";
  const age = Math.max(0, nowMs - updatedAt);
  if (age < 60_000) return "Обновлено только что";
  if (age < 120_000) return "Обновлено минуту назад";
  return `Данные от ${time} · обновите список`;
}
