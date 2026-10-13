"use client";

import Link from "next/link";
import media from "@/public/site/media.json";
import { useState } from "react";
import { ArrowUpRight, Check, Heart, Home, Moon, Sprout, Sun, Users } from "lucide-react";
import styles from "./product-site.module.css";

export function SiteCheckInDemo() {
  const [checked, setChecked] = useState(false);
  return <div className={styles.checkInDemo} data-checked={checked}>
    <span className={styles.demoLabel}><span />Попробуй · демонстрация</span>
    <div className={styles.demoDay}>Сегодня хороший день,<br />чтобы быть рядом.</div>
    <button type="button" className={styles.checkInButton} onClick={() => setChecked(true)} aria-pressed={checked}>
      {checked ? <Check size={34} aria-hidden /> : <Heart size={32} aria-hidden />}<span>{checked ? "Я здесь" : "Я живой"}</span>
    </button>
    <div className={styles.demoReceipt} role="status"><span className={styles.demoAvatar}>М</span><span><strong>{checked ? "Мама видит: всё хорошо" : "Мама"}</strong><small>{checked ? "Так выглядит отметка для близкого" : "Будет рада знать, что ты на связи"}</small></span><span className={checked ? styles.receiptDone : styles.receiptIdle}>{checked ? <Check size={17} aria-hidden /> : "···"}</span></div>
    <p className={styles.demoDisclaimer}>Это пример. Отметка никому не отправляется.</p>
    <div className={styles.resetDemoSlot}>{checked && <button type="button" className={styles.resetDemo} onClick={() => setChecked(false)}>Попробовать ещё раз</button>}</div>
  </div>;
}

// Keep the source selection aligned with the stage widths in product-site.module.css.
const mapSizes = "(max-width: 380px) calc(100vw - 44px), (max-width: 760px) calc(100vw - 56px), (max-width: 950px) calc(100vw - 76px), (max-width: 1200px) calc((100vw - 96px) * .604), (max-width: 1420px) calc((100vw - 160px) * .604), 760px";

const places = [
  { id: "home", title: "Обживай свой дом", label: "Дом", Icon: Home, text: "Начни с маленького домика среди деревьев. Развивай хозяйство, улучшай постройки и открывай новые возможности.", detail: "От первой полянки к своему лесному хозяйству" },
  { id: "workshop", title: "Создавай понемногу", label: "Мастерская", Icon: Sprout, text: "Собирай ресурсы и превращай их в полезные вещи. Мастерская, лесной участок и ягодный куст складываются в своё маленькое хозяйство.", detail: "Ресурсы, рецепты и дело по душе" },
  { id: "neighbors", title: "Заглядывай к соседям", label: "Плёска", Icon: Users, text: "У реки тебя ждёт Плёска с рыбацкой лавкой. Подготовь снасти, отправь Мохлика на рыбалку и пополняй книгу находок.", detail: "Снасти, речные находки и лесные разговоры" },
] as const;

export function SiteWorldDemo({ entryHref = "#install" }: { entryHref?: "/" | "#install" } = {}) {
  const [selected, setSelected] = useState(0);
  const [night, setNight] = useState(false);
  const place = places[selected];
  return <div className={styles.worldDemo}>
    <div className={styles.worldStage} data-night={night}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={media.map.src} srcSet={media.map.srcSet} sizes={mapSizes} width={media.map.width} height={media.map.height} decoding="async" alt="Полянка Мохлика: дом в центре, мастерская слева, лавка Плёски у реки справа" loading="lazy" />
      {night && <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.nightMap} src={media.nightMap.src} srcSet={media.nightMap.srcSet} sizes={mapSizes} width={media.nightMap.width} height={media.nightMap.height} decoding="async" alt="" />
      </>}
      <div className={styles.stageVignette} aria-hidden="true" />
      <div className={styles.stageToolbar}><span><span />Интерактивное знакомство</span><button type="button" onClick={() => setNight(value => !value)} aria-pressed={night} aria-label="Вечерний вид панорамы">{night ? <Moon size={16} aria-hidden /> : <Sun size={16} aria-hidden />}{night ? "Вечер" : "День"}</button></div>
      {places.map(({ id, label, Icon }, index) => <button type="button" key={id} className={styles.mapPin} style={{ left: `${media.mapPlaces[id].x}%`, top: `${media.mapPlaces[id].y}%` }} aria-label={`Узнать: ${label}`} aria-pressed={selected === index} aria-controls="place-description" onClick={() => setSelected(index)}><Icon size={19} aria-hidden /><span>{label}</span></button>)}
      <span className={styles.stageNote}><span aria-hidden="true">✦</span>Выбери место на карте</span>
    </div>
    <div className={styles.worldStory}>
      <div className={styles.storyTabs} aria-label="Места на полянке">{places.map(({ id, label }, index) => <button type="button" key={id} aria-pressed={selected === index} aria-controls="place-description" onClick={() => setSelected(index)}><span>0{index + 1}</span>{label}</button>)}</div>
      <div id="place-description" className={styles.storyContent} aria-live="polite" aria-atomic="true"><span className={styles.storyIcon}><place.Icon size={31} aria-hidden /></span><h3>{place.title}</h3><p>{place.text}</p><small>{place.detail}</small></div>
      <Link href={entryHref} prefetch={false}>{entryHref === "/" ? "Играть на своей полянке" : "Хочу свою полянку"}<ArrowUpRight size={18} aria-hidden /></Link>
    </div>
  </div>;
}

export function SiteVideoPlaceholder() {
  return <div className={styles.videoSection}>
    <div className={styles.videoCopy}><p className={styles.eyebrow}>Почувствовать атмосферу</p><h3>У этого леса<br /><em>свой ритм.</em></h3><p>Тёплый свет в окнах. Дождь на полянке. Маленькие дела Мохлика. Скоро покажем всё это в движении.</p></div>
    <figure className={styles.videoPlaceholder}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={media.poster.src} srcSet={media.poster.srcSet} sizes="(max-width: 380px) calc(100vw - 44px), (max-width: 760px) calc(100vw - 56px), 700px" width={media.poster.width} height={media.poster.height} alt="" loading="lazy" decoding="async" />
      <div className={styles.filmCorners} aria-hidden="true"><span /><span /><span /><span /></div>
      <figcaption><span className={styles.filmLabel}>Видеопрогулка / в подготовке</span><strong>Скоро.</strong><span>Скоро здесь появится видеопрогулка</span></figcaption>
      <span className={styles.filmNote} aria-hidden="true">Мир Мохлика</span>
    </figure>
  </div>;
}
