"use client";

import { ArrowDown, ArrowUpRight, Bell, Check, ChevronRight, Heart, Leaf, Play, Smartphone, Sprout, Trees } from "lucide-react";
import Link from "next/link";
import { BRAND_LOGO_SRC } from "@/lib/brand-assets";
import { InstallPanel } from "@/features/pwa/install-panel";
import { SiteCheckInDemo, SiteWorldDemo, SiteVideo } from "./site-demos";
import styles from "./product-site.module.css";

const questions = [
  ["Что такое PWA?", "Это приложение, которое устанавливается прямо с сайта. После установки у «Я живой» появится свой значок и отдельное окно без привычной строки браузера. Способ установки зависит от устройства — инструкция выше подскажет нужные шаги."],
  ["Я уже играю. Прогресс сохранится?", "Прогресс привязан к аккаунту. В установленном приложении войдите тем же способом — через тот же ВК или почту. На некоторых устройствах понадобится войти заново. Если вы пользовались резервным кодом, сохраните его заранее в профиле."],
  ["Можно играть без интернета?", "Для входа, отметок близким и игровых действий нужно подключение к интернету. Часть графики сохраняется на устройстве, но установка приложения не превращает игру в полностью офлайн-игру."],
  ["Будут приходить уведомления?", "Если вы подключите их в настройках приложения и разрешите на устройстве. Можно выбрать события и тихие часы. На iPhone и iPad для этого нужна установленная на экран «Домой» версия приложения и iOS/iPadOS 16.4 или новее."],
  ["Приложение установлено, но ссылка опять открыла браузер", "Это возможно: обычная ссылка не всегда открывает установленное приложение. Найдите значок «Я живой» на главном экране, в списке приложений или в Dock и запустите его оттуда. Устанавливать ещё одну копию не нужно."],
];

export function ProductSite() {
  return <div className={styles.site}>
    <a className={styles.skip} href="#about">Перейти к содержимому</a>
    <header className={styles.header}>
      <a href="/site" className={styles.wordmark} aria-label="Я живой — главная страница сайта"><Sprout aria-hidden size={27} /><span>я живой<span className={styles.brandDot}>.</span></span></a>
      <nav className={styles.nav} aria-label="О приложении">
        <a href="#about">Идея</a><a href="#world">Мир Мохлика</a><a href="#questions">Вопросы</a>
      </nav>
      <a className={styles.headerInstall} href="#install">Установить <ArrowUpRight size={16} aria-hidden /></a>
    </header>
    <main>
      <section className={styles.hero} aria-labelledby="site-title">
        {/* The tour uses the same authored map and artwork as the game. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.heroForest} src="/site/poster.webp" width={1440} height={900} alt="" fetchPriority="high" />
        <div className={styles.heroShade} />
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}><span /> Маленький ритуал. Живой мир.</p>
          <h1 id="site-title">Близкие спокойны.<br />А у тебя —<br /><em>целый лес.</em></h1>
          <p className={styles.heroIntro}>Скажи «я живой» тем, кто ждёт.<br />И загляни в мир, где тебя тоже ждут.</p>
          <div className={styles.actions}>
            <a className={styles.primary} href="#install"><Smartphone size={19} aria-hidden />Установить приложение<ArrowUpRight size={18} aria-hidden /></a>
            <a className={styles.secondary} href="#world"><Play size={16} aria-hidden />Заглянуть в лес</a>
          </div>
          <p className={styles.heroNote}>На телефон и компьютер · прямо с сайта</p>
        </div>
        <div className={styles.heroBrand}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={BRAND_LOGO_SRC} width={480} height={480} alt="Я живой — Мохлик и лесные друзья" />
          <span className={styles.forestLabel}><span /> Здесь всегда кто-то занят</span>
        </div>
        <a href="#about" className={styles.heroScroll}><ArrowDown size={16} aria-hidden />История начинается с одного нажатия</a>
      </section>

      <section id="about" className={`${styles.section} ${styles.about}`} aria-labelledby="about-title">
        <div className={styles.sectionCopy}>
          <p className={styles.eyebrow}>01 / Быть на связи</p>
          <h2 id="about-title">Иногда достаточно<br />двух слов.</h2>
          <p>Не всегда есть время на длинный разговор. Одна отметка — и близкие знают, что с тобой всё хорошо.</p>
          <p className={styles.muted}>Добавляй своих людей, объединяй их в группы и выбирай, кому виден твой статус. Маленькая привычка, в которой много заботы.</p>
          <div className={styles.inlineNote}><Heart size={18} aria-hidden />Связь с близкими — в основе всего</div>
        </div>
        <SiteCheckInDemo />
      </section>

      <section id="world" className={`${styles.section} ${styles.world}`} aria-labelledby="world-title">
        <div className={styles.sectionHeading}>
          <div><p className={styles.eyebrow}>02 / Немного времени для себя</p><h2 id="world-title">Твоя маленькая<br /><em>большая полянка.</em></h2></div>
          <p>А после — оставайся ненадолго.<br />Обустраивай дом, собирай урожай и знакомься с соседями. У Мохлика всегда найдётся занятие.</p>
        </div>
        <SiteWorldDemo />
        <SiteVideo />
        <div className={styles.worldDetails}>
          <div><Sprout size={22} aria-hidden /><h3>Расти вместе с миром</h3><p>Улучшай постройки, открывай рецепты и собирай свои первые коллекции.</p></div>
          <div><Trees size={22} aria-hidden /><h3>Замечай маленькое</h3><p>В лесу сменяется время суток, шумит дождь, горит костёр и течёт река.</p></div>
          <div><Heart size={22} aria-hidden /><h3>Знакомься с соседями</h3><p>Плёска торгует у реки, Шишколап помогает со стройкой, а Мохлик обживает полянку.</p></div>
        </div>
      </section>

      <section id="install" className={`${styles.section} ${styles.install}`} aria-labelledby="install-title">
        <div className={styles.installCopy}>
          <p className={styles.eyebrow}>03 / Забери этот мир с собой</p>
          <h2 id="install-title">Пусть лес будет<br /><em>под рукой.</em></h2>
          <p>Установи «Я живой» и открывай его одним нажатием на значок — как обычное приложение.</p>
          <ul className={styles.benefits}>
            <li><Check size={18} aria-hidden />Свой значок на экране устройства</li>
            <li><Check size={18} aria-hidden />Больше места для игры без строки браузера</li>
            <li><Bell size={18} aria-hidden />Уведомления, когда ты их разрешишь</li>
          </ul>
          <div className={styles.appTile}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon-192.png" width={66} height={66} alt="Значок приложения «Я живой»" loading="lazy" />
            <span><strong>Я живой</strong><small>Твой лес. Твои люди.</small></span><Leaf size={22} aria-hidden />
          </div>
          <p className={styles.installHint}>Уже установлено? Запускай со значка «Я живой». Обычная ссылка может снова открыть браузер.</p>
        </div>
        <div className={styles.installPanel}><InstallPanel /></div>
      </section>

      <section id="questions" className={`${styles.section} ${styles.questions}`} aria-labelledby="questions-title">
        <div><p className={styles.eyebrow}>Всё просто</p><h2 id="questions-title">На всякий<br />случай.</h2></div>
        <div className={styles.accordion}>{questions.map(([question, answer]) => <details key={question}><summary>{question}<ChevronRight size={20} aria-hidden /></summary><p>{answer}</p></details>)}</div>
      </section>
      <section className={styles.lastWord} aria-label="Начать пользоваться приложением"><Sprout size={30} aria-hidden /><p>Хорошо, что ты есть.</p><a href="#install">Установить «Я живой»<ArrowUpRight size={18} aria-hidden /></a></section>
    </main>
    <footer className={styles.footer}><a href="/site" className={styles.wordmark}><Sprout size={23} aria-hidden />я живой.</a><p>Маленький мир с большим теплом.</p><Link href="/" prefetch={false}>Перейти к приложению<ArrowUpRight size={15} aria-hidden /></Link></footer>
  </div>;
}
