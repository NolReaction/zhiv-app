import type { AnchorHTMLAttributes, ReactNode } from "react";

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string | { pathname?: string; query?: Record<string, string>; hash?: string };
  children: ReactNode; prefetch?: boolean; replace?: boolean; scroll?: boolean;
};

export default function Link({ href, children, prefetch: _prefetch, replace: _replace, scroll: _scroll, ...props }: Props) {
  void _prefetch; void _replace; void _scroll;
  const target = typeof href === "string" ? href : `${href.pathname ?? "/"}${href.query ? `?${new URLSearchParams(href.query)}` : ""}${href.hash ?? ""}`;
  return <a {...props} href={target}>{children}</a>;
}
