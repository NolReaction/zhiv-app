"use client";

import { useEffect, useRef, useState } from "react";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { RewardContents, RewardRecovery } from "@/features/game/daily-rewards";
import { progressionRewardsCatalog } from "@/features/game/progression-rewards";
import { useGameRewards } from "@/features/game/use-game-rewards";
import { GuideCoach } from "@/features/onboarding/guide-coach";
import type { WorldOnboardingProgress } from "@/features/world/domain/world-onboarding";

type Props = {
  owner: string;
  progress: WorldOnboardingProgress | null;
  open: boolean;
  isOnline: boolean;
  onSessionLost?: () => void;
  economy: EconomyController;
  onAcknowledged: () => void;
};

/** Kept mounted with the account: covering the coach cannot discard a receipt. */
export function WorldOnboardingReward({ owner, progress, open, isOnline, onSessionLost, economy, onAcknowledged }: Props) {
  const rewards = useGameRewards(owner, isOnline, onSessionLost, result => {
    if (result.rewards.ownerPublicId === owner && result.economy.ownerPublicId === owner
      && economy.snapshot?.ownerPublicId === owner) void economy.refresh();
  });
  const run = progress?.status === "completed" && progress.rewardReady ? `${owner}:${progress.finishedAt ?? "completed"}` : null;
  const attempted = useRef<string | null>(null);
  const [presentation, setPresentation] = useState<{ open: boolean; dismissed: string | null }>({ open, dismissed: null });
  if (presentation.open !== open) setPresentation({ open, dismissed: null });
  const data = rewards.data?.ownerPublicId === owner ? rewards.data : null;
  const receipt = rewards.result?.rewards.ownerPublicId === owner && rewards.result.economy.ownerPublicId === owner
    && rewards.result.claim.kind === "onboarding" ? rewards.result.claim : null;
  const claimed = Boolean(data?.onboarding?.claimedAt || receipt?.claimedAt);
  const visible = Boolean(run && open && presentation.dismissed !== run);
  const blocked = !isOnline || rewards.loading || rewards.busy || rewards.pending !== null || rewards.uncertain
    || rewards.retryAt > rewards.now;
  const claimOnboarding = rewards.claimOnboarding;
  useEffect(() => {
    // A new visit or restored connection may retry a definitive failure once.
    // A modal only covers the speech; an existing command keeps its owner.
    if (!open || !isOnline) attempted.current = null;
  }, [open, isOnline]);
  useEffect(() => {
    if (!visible || !run || claimed || blocked || !data?.onboarding || attempted.current === run) return;
    // Reserve before the shared command publishes busy/error or resolves. A
    // quick definitive refusal must not create a fresh UUID on every render.
    attempted.current = run;
    void claimOnboarding();
  }, [visible, run, claimed, blocked, data?.onboarding, claimOnboarding]);

  const dismiss = () => setPresentation({ open, dismissed: run });
  const pendingOther = Boolean(rewards.pending && rewards.pending.kind !== "onboarding");
  const claim = () => {
    if (blocked || claimed || !run || !data?.onboarding) return;
    attempted.current = run;
    void claimOnboarding();
  };
  const status = claimed ? "Награда получена в кошелёк."
    : !isOnline ? "Награда сохранена. Для получения нужен интернет."
    : rewards.busy ? pendingOther ? "Дожидаемся подтверждения другой награды." : "Получаем награду…"
    : pendingOther ? "Сначала проверь получение предыдущей награды."
    : rewards.retryAt > rewards.now ? "Нужно немного подождать перед повтором."
    : rewards.loading ? "Проверяем награду…"
    : !data?.onboarding ? "Проверим доступность награды."
    : undefined;
  return <GuideCoach open={visible} flow="world" stepId="completion-reward" title={claimed ? "Подарок твой!" : "Обучение пройдено!"}
    pose={claimed ? "jump" : "present"}
    summary={claimed ? "Спасибо за знакомство с лесом! Можно продолжать приключение." : "За пройденное обучение тебя ждёт подарок."}
    text={claimed ? "Монеты и жемчуг уже в кошельке. Справка и подсказки разделов всегда рядом."
      : "Этот подарок выдаётся один раз за аккаунт. Если закроешь подсказку, получение можно продолжить при следующем заходе."}
    onPause={dismiss} onSkip={dismiss} status={status}
    primary={claimed ? { label: "Продолжить", onClick: onAcknowledged }
      : rewards.uncertain || rewards.pending ? undefined
      : data?.onboarding ? { label: rewards.busy ? "Получаем…" : "Получить награду", disabled: blocked, onClick: claim }
      : { label: "Проверить награду", disabled: !isOnline || rewards.loading || rewards.busy || rewards.retryAt > rewards.now,
        onClick: () => { if (isOnline) void rewards.refresh(); } }}>
    <RewardContents reward={receipt?.reward ?? progressionRewardsCatalog.onboarding} />
    <RewardRecovery controller={rewards} isOnline={isOnline} />
  </GuideCoach>;
}
