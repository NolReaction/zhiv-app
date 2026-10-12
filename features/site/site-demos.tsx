"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Heart, Home, Moon, Play, Sprout, Sun, Users } from "lucide-react";
import styles from "./product-site.module.css";

export function SiteCheckInDemo() {
  const [checked, setChecked] = useState(false);
  return <div className={styles.checkInDemo}>
    <span className={styles.demoLabel}>Попробуй · демонстрация</span>
    <div className={styles.demoDay}>Сегодня — хороший день,<br />чтобы быть рядом.</div>
    <button type="button" className={styles.checkInButton} onClick={() => setChecked(true)} aria-pressed={checked}>
      {checked ? <Check size={34} aria-hidden /> : <Heart size={32} aria-hidden />}<span>{checked ? "Я здесь" : "Я живой"}</span>
    </button>
    <div className={styles.demoReceipt} role="status"><span className={styles.demoAvatar}>М</span><span><strong>{checked ? "Мама видит: всё хорошо" : "Мама"}</strong><small>{checked ? "Так выглядит отметка для близкого" : "Будет рада знать, что ты на связи"}</small></span><span className={checked ? styles.receiptDone : styles.receiptIdle}>{checked ? <Check size={16} aria-hidden /> : "···"}</span></div>
    <p className={styles.demoDisclaimer}>Это пример. Отметка никому не отправляется.</p>
    {checked && <button type="button" className={styles.resetDemo} onClick={() => setChecked(false)}>Попробовать ещё раз</button>}
  </div>;
}

const places = [
  { id: "home", title: "Обживай свой дом", label: "Дом", Icon: Home, x: 53.2, y: 47, text: "Начни с маленького домика среди деревьев. Развивай хозяйство, улучшай постройки и открывай новые возможности.", detail: "От первой полянки — к своему лесному хозяйству" },
  { id: "workshop", title: "Создавай понемногу", label: "Мастерская", Icon: Sprout, x: 17.1, y: 42, text: "Собирай ресурсы и превращай их в полезные вещи. Мастерская, лесной участок и ягодный куст складываются в своё маленькое хозяйство.", detail: "Ресурсы, рецепты и дело по душе" },
  { id: "neighbors", title: "Заглядывай к соседям", label: "Плёска", Icon: Users, x: 84.9, y: 43.5, text: "У реки тебя ждёт Плёска с рыбацкой лавкой. Подготовь снасти, отправь Мохлика на рыбалку и пополняй книгу находок.", detail: "Снасти, речные находки и лесные разговоры" },
] as const;

export function SiteWorldDemo() {
  const [selected, setSelected] = useState(0);
  const [night, setNight] = useState(false);
  const place = places[selected];
  return <div className={styles.worldDemo}>
    <div className={styles.worldStage} data-night={night}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/site/map.webp" width={1600} height={1600} alt="Полянка Мохлика: дом в центре, мастерская слева, лавка Плёски у реки справа" loading="lazy" />
      {night && <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.nightMap} src="/site/map-night.webp" width={1600} height={1600} alt="" />
      </>}
      <div className={styles.stageToolbar}><span>Интерактивное знакомство</span><button type="button" onClick={() => setNight(value => !value)} aria-pressed={night} aria-label="Вечерний вид панорамы">{night ? <Moon size={17} aria-hidden /> : <Sun size={17} aria-hidden />}{night ? "Вечер" : "День"}</button></div>
      {places.map(({ id, label, Icon, x, y }, index) => <button type="button" key={id} className={styles.mapPin} style={{ left: `${x}%`, top: `${y}%` }} aria-label={`Узнать: ${label}`} aria-pressed={selected === index} onClick={() => setSelected(index)}><Icon size={19} aria-hidden /><span>{label}</span></button>)}
      <span className={styles.stageNote}>Выбери место на карте</span>
    </div>
    <div className={styles.worldStory}>
      <div className={styles.storyTabs} aria-label="Места на полянке">{places.map(({ id, label }, index) => <button type="button" key={id} aria-pressed={selected === index} onClick={() => setSelected(index)}><span>0{index + 1}</span>{label}</button>)}</div>
      <div className={styles.storyContent} aria-live="polite"><place.Icon size={32} aria-hidden /><h3>{place.title}</h3><p>{place.text}</p><small>{place.detail}</small></div>
      <a href="#install">Хочу свою полянку<ArrowUpRight size={18} aria-hidden /></a>
    </div>
  </div>;
}

export function SiteVideo() {
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!started) return;
    const element = video.current;
    if (!element) return;
    // Native controls remain available if this browser does not allow play().
    void element.play().catch(() => undefined);
    const stopWhenHidden = () => { if (document.hidden) element.pause(); };
    document.addEventListener("visibilitychange", stopWhenHidden);
    return () => document.removeEventListener("visibilitychange", stopWhenHidden);
  }, [started]);
  return <div className={styles.videoSection}>
    <div><p className={styles.eyebrow}>Посмотри вокруг</p><h3>Двенадцать секунд<br />лесного спокойствия.</h3><p>Домики среди деревьев, тёплый вечер и Мохлик на своей полянке. Короткая видеопрогулка по графике игры.</p><p className={styles.muted}>Без звука. Запускается только по нажатию.</p></div>
    <div className={styles.videoFrame}>
      {started ? <video ref={video} controls playsInline muted preload="metadata" poster="/site/poster.webp" src="/site/forest-tour.mp4" onError={() => setFailed(true)} aria-label="Видеопрогулка: камера приближается к лесной полянке, день сменяется тёплым вечером, затем возвращается дневной свет" /> : <button type="button" onClick={() => setStarted(true)} className={styles.videoStart}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/site/poster.webp" width={1440} height={900} alt="Лесная полянка с домом Мохлика" loading="lazy" /><span><Play size={24} aria-hidden fill="currentColor" />Смотреть прогулку<small>0:12</small></span>
      </button>}
      {failed && <p role="status" className={styles.videoError}>Не удалось загрузить видео. <button type="button" onClick={() => { setFailed(false); video.current?.load(); void video.current?.play().catch(() => undefined); }}>Повторить</button></p>}
    </div>
  </div>;
}
