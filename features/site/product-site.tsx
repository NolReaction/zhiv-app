"use client";

import { useRef } from "react";
import { ArrowDown, ArrowUpRight, Bell, Check, ChevronRight, Heart, Leaf, Pause, Play, Smartphone, Sprout, Trees } from "lucide-react";
import Link from "next/link";
import { BRAND_LOGO_SRC } from "@/lib/brand-assets";
import { usePwaInstall } from "@/features/pwa/install-provider";
import { isDesktopInstallDevice } from "@/features/pwa/install-platform";
import media from "@/public/site/media.json";
import { InstallPanel } from "@/features/pwa/install-panel";
import { ForestAtmosphere } from "./forest-atmosphere";
import { useSiteMotion } from "./use-site-motion";
import { SiteCheckInDemo, SiteWorldDemo, SiteVideoPlaceholder } from "./site-demos";
import styles from "./product-site.module.css";

const questions = [
  ["Можно просто играть на компьютере?", "Да. Нажми «Играть», и откроется твоя полянка. Установка на Windows, macOS и Linux необязательна. На телефоне удобнее добавить приложение на главный экран, но вход через браузер тоже доступен."],
  ["Что такое PWA?", "Это приложение, которое устанавливается прямо с сайта. У «Я живой» появится свой значок и отдельное окно без привычной строки браузера. Сайт подскажет способ установки для твоего устройства."],
  ["Я уже играю. Прогресс сохранится?", "Прогресс привязан к аккаунту. В установленном приложении войди тем же способом: через тот же ВК или почту. На некоторых устройствах понадобится войти заново. Если пользуешься резервным кодом, сохрани его заранее в профиле."],
  ["Можно играть без интернета?", "Для входа, отметок близким и игровых действий нужно подключение к интернету. Часть графики сохраняется на устройстве, но игра не работает полностью офлайн."],
  ["Будут приходить уведомления?", "Если ты подключишь их в настройках приложения и разрешишь на устройстве. Можно выбрать события и тихие часы. На iPhone и iPad для этого нужна установленная на экран «Домой» версия приложения и iOS/iPadOS 16.4 или новее."],
  ["Приложение установлено, но ссылка открыла браузер", "Обычная ссылка не всегда открывает установленное приложение. Найди значок «Я живой» на главном экране, в списке приложений или в Dock и запусти его оттуда. Устанавливать ещё одну копию не нужно."],
];

export function ProductSite() {
  const site = useRef<HTMLDivElement>(null);
  const installation = usePwaInstall();
  const directEntry = installation.ready && (installation.standalone || isDesktopInstallDevice(installation.device));
  const entryHref = directEntry ? "/" : "#install";
  const entryLabel = directEntry ? "Играть" : "Установить приложение";
  const EntryIcon = directEntry ? Play : Smartphone;
  const { motionEnabled, toggleMotion, reducedMotion } = useSiteMotion(site);

  return <div ref={site} className={styles.site}>
    <div className={styles.readingProgress} aria-hidden="true" />
    <a className={styles.skip} href="#about">Перейти к содержимому</a>
    <header className={styles.header}>
      <a href="/site" className={styles.wordmark} aria-label="Я живой. Главная страница сайта"><Sprout aria-hidden size={27} /><span>я живой<span className={styles.brandDot}>.</span></span></a>
      <nav className={styles.nav} aria-label="О приложении"><a href="#about">Забота</a><a href="#world">Маленький мир</a><a href="#questions">Вопросы</a></nav>
      <div className={styles.headerActions}>
        {!reducedMotion && <button type="button" className={styles.headerMotion} aria-label="Спокойный режим" title="Спокойный режим" aria-pressed={!motionEnabled} onClick={toggleMotion}><Pause size={15} aria-hidden /></button>}
        <Link className={styles.headerInstall} href={entryHref} prefetch={false}>{directEntry ? "Играть" : "Установить"} <ArrowUpRight size={16} aria-hidden /></Link>
      </div>
    </header>

    <main>
      <section className={styles.hero} aria-labelledby="site-title">
        {/* Real game artwork stays visible when animation or JavaScript is unavailable. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.heroForest} src={media.poster.src} srcSet={media.poster.srcSet} sizes="(min-width: 1800px) 1980px, 110vw" width={media.poster.width} height={media.poster.height} alt="" fetchPriority="high" decoding="async" />
        <div className={styles.heroShade} />
        <div className={styles.heroLight} aria-hidden="true" />
        <ForestAtmosphere className={styles.heroAtmosphere} enabled={motionEnabled} />
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}><span /> Быть рядом. Даже издалека.</p>
          <h1 id="site-title">Близкие спокойны.<br />А у тебя<br /><em>целый лес.</em></h1>
          <p className={styles.heroIntro}>Два слова для тех, кто ждёт.<br />И маленький мир, в который хочется вернуться.</p>
          <div className={styles.actions}>
            <Link className={styles.primary} href={entryHref} prefetch={false}><EntryIcon size={19} aria-hidden />{entryLabel}<ArrowUpRight size={18} aria-hidden /></Link>
            <a className={styles.secondary} href="#world">Заглянуть в лес<ArrowDown size={16} aria-hidden /></a>
          </div>
          <p className={styles.heroNote}>{directEntry ? "Открой свою полянку · установка по желанию" : "На телефон и компьютер · прямо с сайта"}</p>
        </div>
        <div className={styles.heroBrand}>
          <div className={styles.heroOrbit} aria-hidden="true"><span /><span /><span /></div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={BRAND_LOGO_SRC} width={480} height={480} alt="Я живой. Мохлик и лесные друзья" />
          <span className={styles.forestLabel}><span /> Там, где тебя ждут</span>
        </div>
        <div className={styles.heroFootnote}><span>Забота о своих</span><i aria-hidden="true" /><span>Время для себя</span></div>
        <a href="#about" className={styles.heroScroll}><span><ArrowDown size={17} aria-hidden /></span>История начинается с одного нажатия</a>
      </section>

      <section id="about" className={`${styles.section} ${styles.about}`} aria-labelledby="about-title">
        <div className={styles.sectionCopy} data-site-reveal>
          <p className={styles.eyebrow}><span className={styles.chapterNumber}>01</span> Маленький ритуал</p>
          <h2 id="about-title">Иногда достаточно<br /><em>двух слов.</em></h2>
          <p>Не всегда есть время на длинный разговор. Отметься, и близкие узнают, что с тобой всё хорошо.</p>
          <p className={styles.muted}>Добавляй своих людей, объединяй их в группы и выбирай, кому виден твой статус. Маленькая привычка, в которой много заботы.</p>
          <div className={styles.inlineNote}><Heart size={18} aria-hidden />Всё начинается со связи с близкими</div>
        </div>
        <div className={styles.checkInComposition} data-site-reveal>
          <span className={styles.compositionCaption} aria-hidden="true">Одно нажатие. Много тепла.</span>
          <SiteCheckInDemo />
        </div>
      </section>

      <section id="world" className={`${styles.section} ${styles.world}`} aria-labelledby="world-title">
        <div className={styles.sectionHeading} data-site-reveal>
          <div><p className={styles.eyebrow}><span className={styles.chapterNumber}>02</span> Немного времени для себя</p><h2 id="world-title">Твоя маленькая<br /><em>большая полянка.</em></h2></div>
          <p>Отметка сделана. Можно выдохнуть.<br />Обустраивай дом, собирай урожай и знакомься с соседями. У Мохлика всегда найдётся занятие.</p>
        </div>
        <div data-site-reveal><SiteWorldDemo entryHref={entryHref} /></div>
        <div className={styles.worldDetails} data-site-reveal>
          <div><span className={styles.detailNumber}>01 /</span><Sprout size={24} aria-hidden /><h3>Расти вместе с миром</h3><p>Улучшай постройки, открывай рецепты и собирай свои первые коллекции.</p></div>
          <div><span className={styles.detailNumber}>02 /</span><Trees size={24} aria-hidden /><h3>Замечай маленькое</h3><p>В лесу сменяется время суток, шумит дождь, горит костёр и течёт река.</p></div>
          <div><span className={styles.detailNumber}>03 /</span><Heart size={24} aria-hidden /><h3>Знакомься с соседями</h3><p>Плёска торгует у реки, Шишколап помогает со стройкой, а Мохлик обживает полянку.</p></div>
        </div>
        <div data-site-reveal><SiteVideoPlaceholder /></div>
      </section>

      <section id="install" className={`${styles.section} ${styles.install}`} aria-labelledby="install-title">
        <div className={styles.installCopy} data-site-reveal>
          <p className={styles.eyebrow}><span className={styles.chapterNumber}>03</span> Забери этот мир с собой</p>
          <h2 id="install-title">Пусть лес будет<br /><em>под рукой.</em></h2>
          <p>{directEntry ? <>На компьютере можно сразу играть в браузере.<br />А если хочется отдельное окно и свой значок, установи приложение.</> : <>Свой значок. Своё окно. Твои люди рядом.<br />Установи «Я живой» и возвращайся одним нажатием.</>}</p>
          <ul className={styles.benefits}>
            <li><Check size={18} aria-hidden />Свой значок на экране устройства</li>
            <li><Check size={18} aria-hidden />Больше места для игры без строки браузера</li>
            <li><Bell size={18} aria-hidden />Уведомления, когда ты их разрешишь</li>
          </ul>
          <div className={styles.appTile}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon-192.png" width={68} height={68} alt="Значок приложения «Я живой»" loading="lazy" />
            <span><strong>Я живой</strong><small>Твой лес. Твои люди.</small></span><Leaf size={22} aria-hidden />
          </div>
          <p className={styles.installHint}>Уже установлено? Открывай со значка «Я живой». Обычная ссылка может снова запустить браузер.</p>
        </div>
        <div className={styles.installPanel} data-site-reveal><InstallPanel /></div>
      </section>

      <section id="questions" className={`${styles.section} ${styles.questions}`} aria-labelledby="questions-title">
        <div data-site-reveal><p className={styles.eyebrow}>Небольшие подробности</p><h2 id="questions-title">На всякий<br /><em>случай.</em></h2></div>
        <div className={styles.accordion} data-site-reveal>{questions.map(([question, answer]) => <details key={question}><summary>{question}<ChevronRight size={20} aria-hidden /></summary><p>{answer}</p></details>)}</div>
      </section>

      <section className={styles.lastWord} aria-label="Начать пользоваться приложением">
        <div data-site-reveal><Sprout size={32} aria-hidden /><p>Хорошо, что ты есть.</p><Link href={entryHref} prefetch={false}>{directEntry ? "Начать играть" : "Установить «Я живой»"}<ArrowUpRight size={18} aria-hidden /></Link></div>
        <span className={styles.lastWordBackground} aria-hidden="true">я живой.</span>
      </section>
    </main>

    <footer className={styles.footer}>
      <a href="/site" className={styles.wordmark}><Sprout size={23} aria-hidden />я живой.</a>
      <p>Маленький мир с большим теплом.</p>
      {!reducedMotion && <button type="button" className={styles.motionToggle} aria-pressed={!motionEnabled} onClick={toggleMotion}><Pause size={13} aria-hidden />Спокойный режим</button>}
      <Link href="/" prefetch={false}>Перейти к приложению<ArrowUpRight size={15} aria-hidden /></Link>
    </footer>
  </div>;
}
