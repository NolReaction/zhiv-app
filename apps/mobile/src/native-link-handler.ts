import { Browser } from "@capacitor/browser";
import { NativeBridge } from "./native-bridge";
import { nativeLinkAction } from "./native-links";

/** External content always opens outside the privileged local game document. */
export function installNativeLinkHandler(): () => void {
  const clicked = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!anchor) return;
    const action = nativeLinkAction(anchor.getAttribute("href") ?? "", anchor.target, window.location.href);
    if (!action) return;
    event.preventDefault();
    const pending = action.kind === "website" ? NativeBridge.openWebsite({ path: action.path })
      : action.kind === "browser" ? Browser.open({ url: action.url })
        : Promise.reject(new Error("Unsupported external link"));
    void pending.catch(async () => {
      const { notify } = await import("@/components/app-notifications");
      notify(action.kind === "blocked" ? "Эту ссылку нельзя открыть из приложения." : "Не удалось открыть ссылку. Проверьте подключение и попробуйте ещё раз.", "error");
    });
  };
  document.addEventListener("click", clicked);
  return () => document.removeEventListener("click", clicked);
}
