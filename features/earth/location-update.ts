/** Short capture-time labels shared by map pins and the meeting card. */
export function formatMeetLocationUpdate(timestamp: number, now: number) {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now) || timestamp < 0 || !Number.isFinite(new Date(timestamp).getTime())) return null;
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  return { time: new Date(timestamp).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
    age: minutes < 1 ? "Только что" : minutes < 60 ? `${minutes} мин. назад`
      : minutes < 1_440 ? `${Math.floor(minutes / 60)} ч. назад` : `${Math.floor(minutes / 1_440)} дн. назад`,
    dateTime: new Date(timestamp).toISOString() };
}
