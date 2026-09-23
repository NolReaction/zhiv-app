"use client";

import { useId, useRef, useState } from "react";
import { ChevronDown, FlaskConical, Pin, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { ReleaseNote } from "@/features/updates/release-notes";
import { useReleaseNotes } from "@/features/updates/use-release-notes";
import styles from "./beta-info.module.css";

export function unreadReleaseLabel(count: number): string {
  if (count === 0) return "Beta-тест и обновления";
  const last = count % 10, lastTwo = count % 100;
  const word = last === 1 && lastTwo !== 11 ? "непрочитанное обновление"
    : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? "непрочитанных обновления" : "непрочитанных обновлений";
  return `Beta-тест и обновления: ${count} ${word}`;
}

const dateFormatter = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export function ReleaseNotesList({ releases, unreadIds, expandedId, onToggle }: {
  releases: ReleaseNote[];
  unreadIds: string[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}) {
  const listId = useId();
  return <ol className={styles.releaseList} aria-label="История обновлений" tabIndex={0}>
    {releases.map((release, index) => {
      const expanded = expandedId === release.id;
      const titleId = `${listId}-title-${index}`, detailsId = `${listId}-details-${index}`;
      return <li key={release.id} className={styles.release} data-unread={unreadIds.includes(release.id) || undefined}>
        <h3 className={styles.releaseHeading}>
          <button type="button" id={titleId} className={styles.releaseToggle} aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined} onClick={() => onToggle(release.id)}>
            <span className={styles.releaseSummary}>
              <span className={styles.releaseMeta}>
                <span className={styles.version}>v{release.version}</span>
                <time dateTime={release.date}>{dateFormatter.format(new Date(`${release.date}T00:00:00Z`))}</time>
                {unreadIds.includes(release.id) && <span className={styles.newTag}>Новое</span>}
              </span>
              <span className={styles.releaseTitle}>{release.title}</span>
            </span>
            <ChevronDown size={18} aria-hidden="true" className={styles.chevron} />
          </button>
        </h3>
        {expanded && <div id={detailsId} role="region" aria-labelledby={titleId} className={styles.releaseDetails}>
          <ul>{release.changes.map((change, changeIndex) => <li key={changeIndex}>{change}</li>)}</ul>
        </div>}
      </li>;
    })}
  </ol>;
}

export function BetaInfo({ ownerPublicId }: { ownerPublicId: string }) {
  return <BetaInfoDialog key={ownerPublicId} ownerPublicId={ownerPublicId} />;
}

function BetaInfoDialog({ ownerPublicId }: { ownerPublicId: string }) {
  const { releases, unreadIds, unreadCount, checking, refresh, markRead, refreshError } = useReleaseNotes(ownerPublicId);
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  function changeOpen(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) return;
    const newest = releases[0];
    setExpandedId(newest?.id ?? null);
    if (newest) markRead(newest.id);
    refresh();
  }

  function toggleRelease(id: string) {
    const expanding = id !== expandedId;
    setExpandedId(expanding ? id : null);
    if (expanding) markRead(id);
  }

  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger asChild>
      <button type="button" className={styles.betaBadge} aria-label={unreadReleaseLabel(unreadCount)}>
        <FlaskConical size={14} aria-hidden="true" /><span>beta-test</span>
        {unreadCount > 0 && <span className={styles.unreadBadge} aria-hidden="true">{unreadCount > 99 ? "99+" : unreadCount}</span>}
      </button>
    </DialogTrigger>
    <DialogContent className={styles.dialog} onOpenAutoFocus={event => { event.preventDefault(); titleRef.current?.focus(); }}>
      <DialogHeader>
        <DialogTitle ref={titleRef} tabIndex={-1} className={styles.title}><FlaskConical size={22} aria-hidden="true" />Новости приложения</DialogTitle>
        <DialogDescription className="sr-only">Обратная связь и изменения в версиях приложения. Раскройте обновление, чтобы прочитать подробности.</DialogDescription>
      </DialogHeader>
      <section className={styles.cooperation} aria-label="Сотрудничество и обратная связь">
        <h2><Pin size={14} aria-hidden="true" />Делаем приложение вместе</h2>
        <p>
          Приложение в beta-тесте и идёт активная разработка. Если вы обнаружите баги или захотите предложить идеи, свяжитесь со мной: <a href="mailto:66SH66SH@mail.ru">66SH66SH@mail.ru</a>
        </p>
      </section>
      <section className={styles.updates} aria-label="Обновления приложения">
        <div className={styles.updatesHeader}>
          <h2>Что нового</h2>
          <button type="button" className={styles.refresh} onClick={refresh} disabled={checking} aria-label="Проверить обновления">
            <RefreshCw size={16} aria-hidden="true" className={checking ? styles.spinning : undefined} />
          </button>
        </div>
        <p role="status" className={styles.status}>
          {checking ? "Проверяем обновления…" : refreshError ? "Не удалось проверить новости. Показаны сохранённые записи." : "Новые версии — сверху"}
        </p>
        {releases.length > 0
          ? <ReleaseNotesList releases={releases} unreadIds={unreadIds} expandedId={expandedId} onToggle={toggleRelease} />
          : <p className={styles.empty}>Здесь появятся новости следующих версий.</p>}
      </section>
    </DialogContent>
  </Dialog>;
}
