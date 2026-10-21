/** Use the server's actual window end and duration, never a new window from the moment a panel opens. */
export function marketRefreshCountdown(refreshAt: string | number, refreshSeconds: number, now: number) {
  const end = typeof refreshAt === "number" ? refreshAt : Date.parse(refreshAt);
  if (!Number.isFinite(end) || !Number.isFinite(new Date(end).getTime()) || !Number.isFinite(now) || !Number.isFinite(refreshSeconds) || refreshSeconds <= 0) return null;
  const seconds = Math.max(0, Math.ceil((end - now) / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  const pair = (value: number) => String(value).padStart(2, "0");
  const label = hours ? `${pair(hours)}:${pair(minutes)}:${pair(rest)}` : `${pair(minutes)}:${pair(rest)}`;
  const spoken = `${hours ? `${hours} ч ` : ""}${minutes} мин ${rest} с`;
  return { expired: seconds === 0, seconds, label, spoken, remainingFraction: Math.max(0, Math.min(1, (end - now) / (refreshSeconds * 1000))) };
}
