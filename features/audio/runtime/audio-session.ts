type NavigatorWithAudioSession = { readonly audioSession?: { type: string } };

/** Ask supporting browsers to mix game audio with other apps instead of taking
 * exclusive playback ownership. This is a best-effort session policy, not a way
 * to detect another player's music; unsupported browsers keep their own policy. */
export function configureAmbientAudioSession(browserNavigator?: object | null): boolean {
  try {
    const session = (browserNavigator as NavigatorWithAudioSession | null | undefined)?.audioSession;
    if (!session || !("type" in session)) return false;
    if (session.type !== "ambient") session.type = "ambient";
    return session.type === "ambient";
  } catch {
    // Experimental APIs can be exposed but unavailable in the current browser.
    return false;
  }
}
