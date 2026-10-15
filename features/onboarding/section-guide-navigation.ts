/** A scoped request to reveal an explanation target, never an economic action. */
const eventName = "zhiv:section-guide-show";
export type NavigableGuideSection = "plesk";
type Navigation = { section: NavigableGuideSection; stepId: string };

export function requestSectionGuideNavigation(root: HTMLElement, section: NavigableGuideSection, stepId: string) {
  if (section !== "plesk") return false;
  const content = root.querySelector<HTMLElement>(`[data-section-guide-content="${section}"]`);
  if (!content) return false;
  return !content.dispatchEvent(new CustomEvent<Navigation>(eventName, { cancelable: true, detail: { section, stepId } }));
}

export function listenForSectionGuideNavigation(element: HTMLElement, section: NavigableGuideSection, navigate: (stepId: string) => boolean) {
  if (section !== "plesk") return () => {};
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<Navigation>).detail;
    if (detail?.section === section && typeof detail.stepId === "string" && navigate(detail.stepId)) event.preventDefault();
  };
  element.addEventListener(eventName, listener);
  return () => element.removeEventListener(eventName, listener);
}
