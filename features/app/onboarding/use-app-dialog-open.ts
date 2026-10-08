"use client";

import { useSyncExternalStore } from "react";

function readDialogOpen() {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [aria-modal="true"]'))
    .some(element => element.dataset.state !== "closed" && !element.closest('[hidden], [aria-hidden="true"]'));
}
function subscribe(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["data-state", "hidden", "aria-hidden", "aria-modal", "role"] });
  return () => observer.disconnect();
}
const serverSnapshot = () => false;

/** Invites, audio settings and account dialogs own the screen until they close. */
export function useAppDialogOpen() {
  return useSyncExternalStore(subscribe, readDialogOpen, serverSnapshot);
}
