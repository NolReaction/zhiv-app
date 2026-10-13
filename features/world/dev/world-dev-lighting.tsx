import type { WorldDevState } from "./world-dev-store";
import { WorldLightingEditor } from "./world-lighting-editor";
import styles from "./world-dev-panel.module.css";

type LightingControlsProps = {
  state: WorldDevState;
  change: (patch: Partial<WorldDevState>) => void;
  onNightCampfire: () => void;
  worldView?: boolean;
  onOpenWorld?: () => void;
};

/** Only transient scene controls; account commands are intentionally not a dependency. */
export function WorldDevLighting({ state, change, onNightCampfire, worldView, onOpenWorld }: LightingControlsProps) {
  return <>
    <p className={styles.hint}>Прототип света: формы и условные высоты объектов задают тени на земле. Уже нарисованные тени фона остаются частью изображения.</p>
    <label className={styles.toggle}><input type="checkbox" checked={state.lightShadows}
      onChange={event => change({ lightShadows: event.target.checked })} /><span>Тени от света</span></label>
    <p className={styles.hint}>Выключайте тени для сравнения. Костёр и фонари остаются источниками света.</p>
    <button type="button" onClick={onNightCampfire}>Ночь у костра</button>
    <fieldset className={styles.fieldset}>
      <legend>Солнце и луна</legend>
      <label className={styles.field}><span>Направление света · {state.lightAzimuth}°</span>
        <input type="range" aria-label="Направление света" min={0} max={360} step={1} value={state.lightAzimuth}
          onChange={event => change({ lightAzimuth: Number(event.target.value) })} />
      </label>
      <label className={styles.field}><span>Высота над горизонтом · {state.lightElevation}°</span>
        <input type="range" aria-label="Высота света над горизонтом" min={10} max={80} step={1} value={state.lightElevation}
          onChange={event => change({ lightElevation: Number(event.target.value) })} />
      </label>
      <p className={styles.hint}>Ниже источник — длиннее тени. Направление отсчитывается по плоскости карты.</p>
    </fieldset>
    <label className={styles.field}><span>Качество света</span>
      <select value={state.lightQuality} onChange={event => change({ lightQuality: event.target.value as WorldDevState["lightQuality"] })}>
        <option value="low">Бережный</option><option value="high">Детальный</option>
      </select>
    </label>
    <label className={styles.toggle}><input type="checkbox" checked={state.lightDebug}
      onChange={event => change({ lightDebug: event.target.checked })} /><span>Контуры и высоты объектов</span></label>
    <label className={styles.toggle}><input type="checkbox" checked={state.lightTestLamp}
      onChange={event => change({ lightTestLamp: event.target.checked })} /><span>Тестовая лампа · только DEV</span></label>
    <fieldset className={styles.fieldset} disabled={!state.lightTestLamp}>
      <legend>Положение тестовой лампы</legend>
      <label className={styles.field}><span>По горизонтали · {state.lightLampX}</span>
        <input type="range" aria-label="Лампа по горизонтали" min={0} max={1254} step={1} value={state.lightLampX}
          onChange={event => change({ lightLampX: Number(event.target.value) })} />
      </label>
      <label className={styles.field}><span>По глубине карты · {state.lightLampY}</span>
        <input type="range" aria-label="Лампа по глубине карты" min={0} max={1254} step={1} value={state.lightLampY}
          onChange={event => change({ lightLampY: Number(event.target.value) })} />
      </label>
      <label className={styles.field}><span>Высота лампы · {state.lightLampHeight}</span>
        <input type="range" aria-label="Высота тестовой лампы" min={8} max={150} step={1} value={state.lightLampHeight}
          onChange={event => change({ lightLampHeight: Number(event.target.value) })} />
      </label>
    </fieldset>
    <p className={styles.hint}>Для проверки лампы включите ночь. Координаты лампы задают точку на земле; светящаяся отметка находится выше неё. Все настройки действуют только в текущей DEV-сессии.</p>
    <WorldLightingEditor state={state} change={change} worldView={worldView} onOpenWorld={onOpenWorld} />
  </>;
}
