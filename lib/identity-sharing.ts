export type NativeShareOutcome = "shared" | "cancelled" | "unavailable" | "failed";

export type IdentitySharingResult = {
  copied: boolean;
  shareOutcome: NativeShareOutcome;
};

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
  field.setAttribute("aria-hidden", "true");
  field.style.position = "fixed";
  field.style.top = "0";
  field.style.left = "0";
  field.style.width = "1px";
  field.style.height = "1px";
  field.style.padding = "0";
  field.style.border = "0";
  field.style.opacity = "0";
  field.style.fontSize = "16px";
  field.style.pointerEvents = "none";

  documentApi.body.appendChild(field);

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

function copyTextFromUserGesture(
  text: string,
  environment: IdentitySharingEnvironment | null,
): Promise<boolean> {
  if (!environment) return Promise.resolve(false);

  const clipboard = environment.secureContext
    ? environment.navigator.clipboard
    : undefined;

  if (typeof clipboard?.writeText === "function") {
    try {
      return clipboard.writeText(text).then(
        () => true,
        () => false,
      );
    } catch {
      // A synchronous Clipboard API failure can still use the legacy user-gesture path.
    }
  }

  return Promise.resolve(copyWithLegacyCommand(environment.document, text));
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

export function shareIdentity(
  publicId: string,
  environment: IdentitySharingEnvironment | null = getBrowserEnvironment(),
): Promise<IdentitySharingResult> {
  const shareData: ShareData = {
    title: "Жив",
    text: `Добавь меня в «Жив» по ID: ${publicId}`,
  };

  // Both privileged browser actions must start in the same trusted click.
  // Do not place an await between these calls: Safari would lose transient activation.
  const copyPromise = copyTextFromUserGesture(publicId, environment);
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
