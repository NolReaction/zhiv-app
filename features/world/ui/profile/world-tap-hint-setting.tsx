"use client";

import { useId } from "react";
import { SharingSwitch as Switch } from "@/components/sharing-switch";
import { useTapHintPreference } from "@/features/world/state/use-tap-hint-preferences";
import styles from "./world-tap-hint-setting.module.css";

export function WorldTapHintSetting({ owner, tone = "default" }: { owner: string; tone?: "default" | "forest" }) {
  const id = useId();
  const { showTapHints, setShowTapHints } = useTapHintPreference(owner);
  return <div className={styles.setting} data-tone={tone}>
    <label htmlFor={id}><strong>Подсказки нажатия</strong><span id={`${id}-description`}>Ромбики на объектах карты. Сами объекты и подсветка обучения останутся доступны.</span></label>
    <Switch id={id} checked={showTapHints} onCheckedChange={setShowTapHints} aria-describedby={`${id}-description`} data-audio-cue="ui.click" />
  </div>;
}
