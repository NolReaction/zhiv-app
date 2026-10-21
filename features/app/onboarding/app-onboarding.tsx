"use client";

import { useImperativeHandle, type Ref } from "react";
import { GuideCoach, type GuideCoachProps } from "@/features/onboarding/guide-coach";
import { APP_ONBOARDING_STEPS, type AppOnboardingEvidence } from "./app-onboarding-model";
import { useAppOnboarding } from "./use-app-onboarding";
import { useAppDialogOpen } from "./use-app-dialog-open";
import { useAppGuideTarget } from "./use-app-guide-target";

export type AppOnboardingEntry = { open: () => void; getActionLabel: () => string };

type Props = AppOnboardingEvidence & {
  entryRef?: Ref<AppOnboardingEntry>;
  owner: string;
  ready: boolean;
  suspended: boolean;
  isOnline: boolean;
  calendarAvailable: boolean;
  simpleView: boolean;
};

const target = (name: string) => `[data-app-onboarding="${name}"]`;

export function AppOnboarding(props: Props) {
  const { ready, suspended, activeView, calendarOpen, worldOpen, isOnline, isSending, unconfirmed,
    simpleView, calendarAvailable } = props;
  const guide = useAppOnboarding(props.owner, ready, props);
  useImperativeHandle(props.entryRef, () => ({
    open: () => { if (guide.progress?.status === "started") guide.resume(); else guide.replay(); },
    getActionLabel: () => guide.progress?.status === "started" ? "Продолжить обучение"
      : guide.progress ? "Повторить обучение" : "Начать обучение",
  }));
  const dialogOpen = useAppDialogOpen();
  const progress = guide.progress?.status === "started" ? guide.progress : null;
  const stepId = progress?.stepId ?? "welcome";
  const done = Boolean(progress?.completedSteps.includes(progress.stepId));
  const home = activeView === "check-in";
  let content: Pick<GuideCoachProps, "title" | "summary" | "text" | "hint" | "pose" | "target" | "primary" | "status">;
  if (stepId === "welcome") {
    content = {
      title: "Привет! Я Мохлик",
      summary: "Помогу отметиться, найти близких и заглянуть в мой лес.",
      text: "Здесь близкие видят твои отметки. Покажу кнопки приложения и мой лес. Начнём?",
      pose: "greet", primary: { label: "Начать", onClick: guide.start },
    };
  } else if (stepId === "check-in") {
    content = {
      title: done ? "Отметка уже сохранена!" : "Попробуй отметиться",
      summary: done ? home ? "Отметка сохранена! Нажми подсвеченный огонёк с числом дней: там календарь отметок."
        : "Отметка сохранена! Нажми «Я живой» внизу, затем огонёк с числом дней: там календарь."
        : home ? "Нажми «Я ЖИВОЙ» и дождись подтверждения под кнопкой."
          : "Нажми «Я живой» внизу, затем большую кнопку отметки.",
      text: done ? "Отметка подтверждена, близкие смогут её увидеть. Огонёк с числом дней над большой кнопкой открывает календарь: посмотри историю отметок и затем закрой его, чтобы продолжить."
        : "Нажми «Я ЖИВОЙ» - сохраним время твоей отметки. Дождись подтверждения под кнопкой.",
      hint: !isOnline ? "Сейчас нет интернета. Можно вернуться к отметке позже и продолжить знакомство."
        : unconfirmed ? "Пока нет подтверждения отправки. Под кнопкой можно проверить связь; ждать здесь необязательно."
          : isSending ? "Ждём подтверждения сохранения…" : done ? "Если ты отмечался недавно, повторять отметку ради обучения не нужно."
            : undefined,
      pose: done ? "jump" : "reach", target: target(home ? done ? "calendar" : "check-in" : "nav-check-in"),
      status: done ? "Отметка подтверждена. Действие: открой календарь" : isSending ? "Сохраняем…" : undefined,
    };
  } else if (stepId === "calendar") {
    content = {
      title: done ? "Вот где живёт история отметок" : "Открой свой календарь",
      summary: done ? "Здесь дни с отметками и твоя серия. Календарь всегда доступен по огоньку."
        : home ? "Нажми на огонёк с числом дней: откроется календарь отметок."
          : "Нажми «Я живой» внизу. На главном экране открой огонёк с числом дней.",
      text: done ? "В календаре видны дни с отметками и серия дней подряд. Его можно открывать в любое время - запоминать цифры не нужно."
        : "Нажми на огонёк с числом дней над большой кнопкой. Откроется настоящий календарь: посмотри его, а затем закрой, чтобы продолжить.",
      hint: calendarAvailable ? "Пока календарь открыт, я уберу подсказку и дам спокойно посмотреть." : "Календарь ещё загружается. Этот шаг можно отложить.",
      pose: done ? "present" : "wonder", target: target(home ? "calendar" : "nav-check-in"),
      primary: done ? { label: "Дальше: мои люди", onClick: guide.next, advance: true }
        : undefined,
      status: done ? "Календарь открыт и просмотрен" : "Действие: открой календарь",
    };
  } else if (stepId === "people") {
    content = {
      title: done ? "Здесь твои люди" : "Заглянем к людям",
      summary: activeView === "people" ? "Под карточкой друга две кнопки: «Статус» и «Геопозиция». Подсвеченная кнопка означает, что обновления разрешены."
        : "Открой «Люди»: здесь друзья, группы и отметки близких.",
      text: done ? "Близкого можно добавить по ID или приглашению. Две компактные кнопки «Статус» и «Геопозиция» отдельно разрешают обновления отметок и места. Подсветка означает, что доступ включён. Нажми имя или аватар друга, чтобы открыть профиль: в «Обзоре» можно пойти в гости, в «Находках» листать коллекции влево и вправо, а в «Связи» изменить подпись и полностью убрать геодоступ. Выключение обновлений сохраняет последнее место; «Убрать доступ» удаляет его."
        : "Нажми «Люди» внизу. Здесь живут друзья и группы, а рядом с человеком видно, как давно он отмечался, если он делится этой информацией.",
      hint: "Участников на карте можно листать по горизонтали. Нажми значок друга на карте, чтобы открыть встречу и выбрать приложение для маршрута. Кнопка книги открывает личный атлас с мини-путешествиями. Открытия отмечаются отдельной кнопкой. Для обучения менять доступ не нужно.",
      pose: done ? "greet" : "present", target: target(activeView === "people" ? "people-content" : "nav-people"),
      primary: done && activeView === "people" ? { label: "Дальше: мой профиль", onClick: guide.next, advance: true }
        : undefined,
      status: done ? "Раздел «Люди» открыт" : "Действие: перейди в «Люди»",
    };
  } else if (stepId === "profile") {
    content = {
      title: done ? "Профиль и доступ к аккаунту" : "Посмотрим настройки",
      summary: activeView === "profile" ? "Нажми шестерёнку рядом с «Профиль»: здесь геопозиция, звук, уведомления и внешний вид."
        : "Открой «Профиль»: покажу настройки и восстановление доступа.",
      text: done ? "Шестерёнка рядом с «Профиль» открывает настройки. В «Геопозиции» можно проверить разрешение и точность или полностью выключить определение места на устройстве и закрыть доступ друзей. Повторное включение не начинает передачу автоматически. Здесь же настраиваются звук, уведомления и внешний вид. Личные данные и восстановление доступа остаются во вкладке «Профиль»."
        : "Нажми «Профиль» внизу. Покажу, где менять настройки и как вернуться к этому аккаунту на другом устройстве.",
      hint: done ? "Под именем — уровень и достижения. Имя меняется через «Личные данные». Менять данные или подключать способ входа для обучения не требуется." : "Это профиль всего приложения. На карте у Мохлика будет своё меню.",
      pose: done ? "hold" : "wonder", target: target(activeView === "profile" ? "profile-settings" : "nav-profile"),
      primary: done && activeView === "profile" ? { label: "К полянке Мохлика", onClick: guide.next, advance: true }
        : undefined,
      status: done ? "Профиль открыт" : "Действие: перейди в «Профиль»",
    };
  } else {
    content = {
      title: "Теперь - на мою полянку!",
      summary: home ? "Нажми «Войти в мир» под большой кнопкой. В лесу попробуем посадить ягоды."
        : "Нажми «Я живой» внизу, затем «Войти в мир» под большой кнопкой.",
      text: "На главном экране под большой кнопкой есть «Войти в мир». Там отдельное знакомство с картой: попробуем настоящее дело - вырастить и собрать ягоды.",
      hint: simpleView ? "У тебя выбрана простая кнопка. Карту всё равно можно открыть через «Войти в мир»; менять оформление не нужно."
        : "Приложением можно пользоваться и без игры. А обучение всегда доступно по знаку вопроса рядом с шестерёнкой в профиле.",
      pose: "walk", target: target(home ? "world" : "nav-check-in"),
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
