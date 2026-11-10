"use client";

import { Dialog } from "radix-ui";
import type { ReactElement, ReactNode } from "react";
import styles from "./world-cookbook.module.css";

/** Kept in the map tree so tutorial targets retain their existing root. */
export function WorldCookbookDialog({ children, onClose, onReturnFocus }: { children: ReactElement; onClose: () => void; onReturnFocus?: () => void }) {
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Overlay className={styles.overlay} onPointerDown={event => event.stopPropagation()} />
    <Dialog.Content asChild aria-describedby={undefined} onOpenAutoFocus={event => event.preventDefault()}
      onCloseAutoFocus={event => { if (onReturnFocus) { event.preventDefault(); onReturnFocus(); } }}
      onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => event.stopPropagation()}>
      {children}
    </Dialog.Content>
  </Dialog.Root>;
}

export function WorldCookbookTitle({ children }: { children: ReactNode }) { return <Dialog.Title>{children}</Dialog.Title>; }
