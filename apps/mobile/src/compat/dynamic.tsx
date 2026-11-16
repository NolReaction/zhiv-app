import { lazy, Suspense, type ComponentType, type ReactNode } from "react";

/** Next's SSR boundary becomes an ordinary lazy client boundary in the installed bundle. */
export default function dynamic<Props extends object>(
  loader: () => Promise<ComponentType<Props> | { default: ComponentType<Props> }>,
  options: { ssr?: boolean; loading?: () => ReactNode } = {},
): ComponentType<Props> {
  const Component = lazy(async () => {
    const loaded = await loader();
    return { default: typeof loaded === "function" ? loaded : (loaded as { default: ComponentType<Props> }).default };
  });
  return function ClientBoundary(props: Props) {
    return <Suspense fallback={options.loading?.() ?? null}><Component {...props} /></Suspense>;
  };
}
