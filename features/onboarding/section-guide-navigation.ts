/** A scoped request to reveal an explanation target, never an economic action. */
const eventName = "zhiv:section-guide-show";
export type NavigableGuideSection = "plesk" | "meals";
type Navigation = { section: NavigableGuideSection; stepId: string };

export function requestSectionGuideNavigation(root: HTMLElement, section: NavigableGuideSection, stepId: string) {
  const content = root.querySelector<HTMLElement>(`[data-section-guide-content="${section}"]`);
  if (!content) return false;
  return !content.dispatchEvent(new CustomEvent<Navigation>(eventName, { cancelable: true, detail: { section, stepId } }));
}

export function listenForSectionGuideNavigation(element: HTMLElement, section: NavigableGuideSection, navigate: (stepId: string) => boolean) {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<Navigation>).detail;
    if (detail?.section === section && typeof detail.stepId === "string" && navigate(detail.stepId)) event.preventDefault();
  };
  element.addEventListener(eventName, listener);
  return () => element.removeEventListener(eventName, listener);
}
