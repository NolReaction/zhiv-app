export type NativeShareOutcome = "shared" | "cancelled" | "unavailable" | "failed";

export type IdentitySharingResult = {
  copied: boolean;
  shareOutcome: NativeShareOutcome;
};

export type CopyTextOutcome = "confirmed" | "legacy" | "failed";

type ClipboardLike = {
  writeText(text: string): Promise<void>;
};

type NavigatorLike = {
  clipboard?: ClipboardLike;
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
};

export type IdentitySharingEnvironment = {
  document: Document;
  navigator: NavigatorLike;
  secureContext: boolean;
};

function getBrowserEnvironment(): IdentitySharingEnvironment | null {
  if (typeof document === "undefined" || typeof navigator === "undefined") return null;

  return {
    document,
    navigator,
    secureContext: globalThis.isSecureContext === true,
  };
}

function attemptLegacyCopy(documentApi: Document, text: string): boolean {
  if (!documentApi.body || typeof documentApi.execCommand !== "function") return false;

  const previousFocus = documentApi.activeElement;
  const activeDialog = previousFocus?.closest?.('[role="dialog"]');
  const openDialog = documentApi.querySelector?.<Element>(
    '[role="dialog"][data-state="open"]',
  );
  const copyRoot = activeDialog ?? openDialog ?? documentApi.body;
  const selection = documentApi.getSelection();
  const savedRanges: Range[] = [];

  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      savedRanges.push(selection.getRangeAt(index).cloneRange());
    }
  }

  const field = documentApi.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.setAttribute("readonly", "");
  field.setAttribute("aria-hidden", "true");
  field.style.position = "fixed";
  field.style.top = "0";
  field.style.left = "0";
  field.style.width = "1px";
  field.style.height = "1px";
  field.style.padding = "0";
  field.style.border = "0";
  field.style.margin = "0";
  field.style.opacity = "0";
  field.style.fontSize = "16px";
  field.style.pointerEvents = "none";

  // Radix keeps focus inside an open dialog. If the temporary field is mounted
  // under document.body, its focus can be reclaimed before iOS transfers the
  // selected value to the pasteboard even though execCommand reports success.
  // Keep focus, selection and the legacy command synchronous in the original tap.
  copyRoot.appendChild(field);

  let copied = false;
  try {
    field.focus();
    field.select();
    field.setSelectionRange(0, field.value.length);
    copied = documentApi.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    field.remove();

    if (
      previousFocus &&
      "focus" in previousFocus &&
      typeof previousFocus.focus === "function"
    ) {
      previousFocus.focus();
    }

    if (selection) {
      selection.removeAllRanges();
      for (const range of savedRanges) selection.addRange(range);
    }
  }

  return copied;
}

function copyWithLegacyCommand(documentApi: Document, text: string): boolean {
  try {
    return attemptLegacyCopy(documentApi, text);
  } catch {
    return false;
  }
}

function copyWithVisibleField(
  documentApi: Document,
  text: string,
  field: HTMLInputElement | HTMLTextAreaElement,
): boolean {
  if (typeof documentApi.execCommand !== "function") return false;

  try {
    if (field.value !== text) field.value = text;
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, field.value.length);
    return documentApi.execCommand("copy");
  } catch {
    return false;
  }
}

function copyTextFromUserGesture(
  text: string,
  environment: IdentitySharingEnvironment | null,
): Promise<boolean> {
  if (!environment) return Promise.resolve(false);

  const clipboard = environment.secureContext
    ? environment.navigator.clipboard
    : undefined;

  if (typeof clipboard?.writeText === "function") {
    let modernCopy: Promise<void> | null = null;
    try {
      modernCopy = clipboard.writeText(text);
    } catch {
      // A synchronous Clipboard API failure can still use the legacy user-gesture path.
    }

    // Safari can reject the standards-based write only after transient activation
    // has expired. Run the same-text legacy attempt now, inside the original tap,
    // so an asynchronous rejection cannot make both paths unavailable.
    const legacyCopied = copyWithLegacyCommand(environment.document, text);
    if (modernCopy) {
      return modernCopy.then(
        () => true,
        () => legacyCopied,
      );
    }
    return Promise.resolve(legacyCopied);
  }

  return Promise.resolve(copyWithLegacyCommand(environment.document, text));
}

export function copyText(
  text: string,
  environment: IdentitySharingEnvironment | null = getBrowserEnvironment(),
): Promise<boolean> {
  return copyTextFromUserGesture(text, environment);
}

export function copyTextFromVisibleField(
  text: string,
  field: HTMLInputElement | HTMLTextAreaElement,
  environment: IdentitySharingEnvironment | null = getBrowserEnvironment(),
): Promise<CopyTextOutcome> {
  if (!environment) return Promise.resolve("failed");

  const clipboard = environment.secureContext
    ? environment.navigator.clipboard
    : undefined;
  let modernCopy: Promise<void> | null = null;

  if (typeof clipboard?.writeText === "function") {
    try {
      // Start the standards-based write before selection changes. The visible-field
      // fallback still runs in this same trusted tap for Safari on local HTTP.
      modernCopy = clipboard.writeText(text);
    } catch {
      modernCopy = null;
    }
  }

  const legacyCopied = copyWithVisibleField(environment.document, text, field);
  if (!modernCopy) {
    return Promise.resolve(legacyCopied ? "legacy" : "failed");
  }

  return modernCopy.then(
    () => "confirmed",
    () => (legacyCopied ? "legacy" : "failed"),
  );
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

function startNativeShare(
  data: ShareData,
  environment: IdentitySharingEnvironment | null,
): Promise<NativeShareOutcome> {
  if (
    !environment?.secureContext ||
    typeof environment.navigator.share !== "function"
  ) {
    return Promise.resolve("unavailable");
  }

  try {
    if (
      typeof environment.navigator.canShare === "function" &&
      !environment.navigator.canShare(data)
    ) {
      return Promise.resolve("unavailable");
    }

    return environment.navigator.share(data).then(
      () => "shared",
      (error: unknown) => (isAbortError(error) ? "cancelled" : "failed"),
    );
  } catch (error) {
    return Promise.resolve(isAbortError(error) ? "cancelled" : "failed");
  }
}

export function shareContent(
  data: ShareData,
  environment: IdentitySharingEnvironment | null = getBrowserEnvironment(),
): Promise<NativeShareOutcome> {
  return startNativeShare(data, environment);
}

export function shareIdentity(
  publicId: string,
  environment: IdentitySharingEnvironment | null = getBrowserEnvironment(),
): Promise<IdentitySharingResult> {
  const shareData: ShareData = {
    title: "Я живой",
    text: `Добавь меня в «Я живой» по ID: ${publicId}`,
  };

  // Both privileged browser actions must start in the same trusted click.
  // Do not place an await between these calls: Safari would lose transient activation.
  const copyPromise = copyText(publicId, environment);
  const sharePromise = startNativeShare(shareData, environment);

  return Promise.all([copyPromise, sharePromise]).then(([copied, shareOutcome]) => ({
    copied,
    shareOutcome,
  }));
}

export function shareTextAndCopy(
  text: string,
  shareData: ShareData,
  environment: IdentitySharingEnvironment | null = getBrowserEnvironment(),
): Promise<IdentitySharingResult> {
  const copyPromise = copyText(text, environment);
  const sharePromise = startNativeShare(shareData, environment);
  return Promise.all([copyPromise, sharePromise]).then(([copied, shareOutcome]) => ({
    copied,
    shareOutcome,
  }));
}

export function getIdentitySharingNotice(result: IdentitySharingResult): string {
  if (result.copied) return "ID скопирован";
  if (result.shareOutcome === "shared") {
    return "Поделиться удалось, но ID не скопирован";
  }
  return "Не скопировано — зажмите ID";
}
