import styles from "./guide-coach.module.css";

export function GuideExitPrompt({ action, help, onCancel, onConfirm }: {
  action: "pause" | "skip"; help: string; onCancel: () => void; onConfirm: () => void;
}) {
  return <div className={styles.exitPrompt} role="group" aria-label={action === "pause" ? "Приостановить обучение?" : "Пропустить обучение?"}>
    <h3>{action === "pause" ? "Скрыть обучение на время?" : "Пропустить весь курс?"}</h3>
    <p>{action === "pause" ? "Подсказки исчезнут, текущий шаг сохранится. Игра продолжится."
      : "Курс прервётся и больше не откроется сам. Пропуск не считается прохождением. К нему можно вернуться позже."}</p>
    <p>{help}</p>
    <div className={styles.exitActions}>
      <button type="button" className={styles.primary} data-guide-pause onClick={onCancel}>Продолжить обучение</button>
      <button type="button" className={styles.secondary} onClick={onConfirm}>{action === "pause" ? "Скрыть, сохранив шаг" : "Да, пропустить курс"}</button>
    </div>
  </div>;
}
