"use client";

import { useImperativeHandle, type Ref } from "react";
import { GuideCoach, type GuideCoachProps } from "@/features/onboarding/guide-coach";
import { APP_ONBOARDING_STEPS, type AppOnboardingEvidence } from "./app-onboarding-model";
import { useAppOnboarding } from "./use-app-onboarding";
import { useAppDialogOpen } from "./use-app-dialog-open";
import { useAppGuideTarget } from "./use-app-guide-target";

export type AppOnboardingEntry = { open: () => void };

type Props = AppOnboardingEvidence & {
  entryRef?: Ref<AppOnboardingEntry>;
  owner: string;
  ready: boolean;
  suspended: boolean;
  isOnline: boolean;
  calendarAvailable: boolean;
  simpleView: boolean;
  onSelect: (view: AppOnboardingEvidence["activeView"]) => void;
  onOpenCalendar: () => void;
  onEnterWorld: () => void;
};

const target = (name: string) => `[data-app-onboarding="${name}"]`;

export function AppOnboarding(props: Props) {
  const { ready, suspended, activeView, calendarOpen, worldOpen, isOnline, isSending, unconfirmed,
    simpleView, calendarAvailable, onSelect, onOpenCalendar, onEnterWorld } = props;
  const guide = useAppOnboarding(props.owner, ready, props);
  useImperativeHandle(props.entryRef, () => ({
    open: () => { if (guide.progress?.status === "started") guide.resume(); else guide.replay(); },
  }));
  const dialogOpen = useAppDialogOpen();
  const progress = guide.progress?.status === "started" ? guide.progress : null;
  const stepId = progress?.stepId ?? "welcome";
  const done = Boolean(progress?.completedSteps.includes(progress.stepId));
  const home = activeView === "check-in";
  const goHome = { label: "К кнопке «Я живой»", onClick: () => onSelect("check-in") };
  let content: Pick<GuideCoachProps, "title" | "summary" | "text" | "hint" | "pose" | "target" | "primary" | "status">;
  if (stepId === "welcome") {
    content = {
      title: "Привет! Я Мохлик",
      summary: "Помогу отметиться, найти близких и заглянуть в мой лес.",
      text: "Отмечайся, чтобы близкие видели, что ты здесь. Покажу основные кнопки, а потом заглянем в мой лес.",
      pose: "greet", primary: { label: "Попробовать вместе", onClick: () => { onSelect("check-in"); guide.start(); } },
    };
  } else if (stepId === "check-in") {
    content = {
      title: done ? "Отметка уже сохранена!" : "Попробуй отметиться",
      summary: done ? "Отметка подтверждена. Посмотрим историю в календаре?" : "Нажми «Я ЖИВОЙ» и дождись подтверждения под кнопкой.",
      text: done ? "Теперь в аккаунте есть подтверждённая отметка. Близкие, с которыми вы делитесь отметками, смогут увидеть, когда ты был здесь. Посмотрим историю?"
        : "Нажми «Я ЖИВОЙ» — сохраним время твоей отметки. Дождись подтверждения под кнопкой.",
      hint: !isOnline ? "Сейчас нет интернета. Можно вернуться к отметке позже и продолжить знакомство."
        : unconfirmed ? "Пока нет подтверждения отправки. Под кнопкой можно проверить связь; ждать здесь необязательно."
          : isSending ? "Ждём подтверждения сохранения…" : done ? "Если ты отмечался недавно, повторять отметку ради обучения не нужно."
            : undefined,
      pose: done ? "jump" : "reach", target: done ? undefined : target(home ? "check-in" : "nav-check-in"),
      primary: done ? { label: "Посмотреть календарь", onClick: guide.next, advance: true } : !home ? goHome : undefined,
      status: done ? "Отметка подтверждена" : isSending ? "Сохраняем…" : undefined,
    };
  } else if (stepId === "calendar") {
    content = {
      title: done ? "Вот где живёт история отметок" : "Открой свой календарь",
      summary: done ? "Здесь дни с отметками и твоя серия. Календарь всегда доступен по огоньку."
        : "Нажми на огонёк с числом дней: откроется календарь отметок.",
      text: done ? "В календаре видны дни с отметками и серия дней подряд. Его можно открывать в любое время — запоминать цифры не нужно."
        : "Нажми на огонёк с числом дней над большой кнопкой. Откроется настоящий календарь: посмотри его, а затем закрой, чтобы продолжить.",
      hint: calendarAvailable ? "Пока календарь открыт, я уберу подсказку и дам спокойно посмотреть." : "Календарь ещё загружается. Этот шаг можно отложить.",
      pose: done ? "present" : "wonder", target: target(home ? "calendar" : "nav-check-in"),
      primary: done ? { label: "Дальше: мои люди", onClick: guide.next, advance: true }
        : !home ? goHome : calendarAvailable ? { label: "Открыть календарь", onClick: onOpenCalendar } : undefined,
      status: done ? "Календарь открыт и просмотрен" : "Действие: открой календарь",
    };
  } else if (stepId === "people") {
    content = {
      title: done ? "Здесь твои люди" : "Заглянем к людям",
      summary: activeView === "people" ? "Здесь друзья и группы. Близкого можно добавить по ID или приглашению."
        : "Открой «Люди»: здесь друзья, группы и отметки близких.",
      text: done ? "Здесь можно добавлять близких по ID, принимать приглашения и собираться в группы. Посмотри раздел: приглашать кого-то прямо сейчас необязательно."
        : "Нажми «Люди» внизу. Здесь живут друзья и группы, а рядом с человеком видно, как давно он отмечался, если он делится этой информацией.",
      hint: "Можно открывать карточки и изучать раздел. Когда будешь готов — продолжим.",
      pose: done ? "greet" : "present", target: target(activeView === "people" ? "people-content" : "nav-people"),
      primary: done && activeView === "people" ? { label: "Дальше: мой профиль", onClick: guide.next, advance: true }
        : { label: "Открыть «Люди»", onClick: () => onSelect("people") },
      status: done ? "Раздел «Люди» открыт" : "Действие: перейди в «Люди»",
    };
  } else if (stepId === "profile") {
    content = {
      title: done ? "Профиль и доступ к аккаунту" : "Посмотрим настройки",
      summary: activeView === "profile" ? "Нажми «Личные данные»: здесь имя и часовой пояс. Ниже — вход и безопасность, под шестерёнкой — звук и вид."
        : "Открой «Профиль»: покажу настройки и восстановление доступа.",
      text: done ? "В «Личных данных» — имя и часовой пояс. Во «Входе и безопасности» — способы входа и восстановление доступа. Шестерёнка открывает настройки звука и внешнего вида: простую кнопку или живую полянку."
        : "Нажми «Профиль» внизу. Покажу, где менять настройки и как вернуться к этому аккаунту на другом устройстве.",
      hint: done ? "Можно раскрыть настройки и осмотреться. Менять данные или подключать способ входа для обучения не требуется." : "Это профиль всего приложения. На карте у Мохлика будет своё меню.",
      pose: done ? "hold" : "wonder", target: target(activeView === "profile" ? "profile-content" : "nav-profile"),
      primary: done && activeView === "profile" ? { label: "К полянке Мохлика", onClick: guide.next, advance: true }
        : { label: "Открыть профиль", onClick: () => onSelect("profile") },
      status: done ? "Профиль открыт" : "Действие: перейди в «Профиль»",
    };
  } else {
    content = {
      title: "Теперь — на мою полянку!",
      summary: "«Войти в мир» откроет лес. Там попробуем посадить ягоды.",
      text: "На главном экране под большой кнопкой есть «Войти в мир». Там отдельное знакомство с картой: попробуем настоящее дело — вырастить и собрать ягоды.",
      hint: simpleView ? "У тебя выбрана простая кнопка. Карту всё равно можно открыть через «Войти в мир»; менять оформление не нужно."
        : "Приложением можно пользоваться и без игры. А обучение всегда доступно по знаку вопроса рядом с шестерёнкой в профиле.",
      pose: "walk", target: target(home ? "world" : "nav-check-in"),
      primary: home ? { label: "Войти в мир", onClick: onEnterWorld } : goHome,
      status: "Действие: открой карту или заверши знакомство",
    };
  }
  const open = ready && guide.open && !suspended && !worldOpen && !calendarOpen && !dialogOpen;
  useAppGuideTarget(open, content.target, stepId, activeView);
  return <>
    <GuideCoach {...content} open={open} inline
      flow="app" stepId={stepId} welcome={stepId === "welcome"} compact={stepId !== "welcome"}
      progress={progress ? { current: APP_ONBOARDING_STEPS.indexOf(progress.stepId) + 1, total: APP_ONBOARDING_STEPS.length } : undefined}
      secondary={stepId === "welcome" ? undefined
        : { label: stepId === "world" ? "Закончить без игры" : "Этот шаг позже", onClick: guide.next }}
      onPause={guide.pause} onSkip={guide.skip}
      onBack={progress && progress.stepId !== "check-in" ? guide.back : undefined} />
  </>;
}
