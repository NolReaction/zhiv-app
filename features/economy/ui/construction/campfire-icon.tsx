import type { SVGProps } from "react";

/** A small cooking fire reads clearly even without the map or a station label. */
export function CampfireIcon({ size = 32, ...props }: SVGProps<SVGSVGElement> & { size?: number | string }) {
  return <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true" data-campfire-icon="true" {...props}>
    <ellipse cx="32" cy="54" rx="26" ry="6" fill="#aaa37d" opacity=".25" />
    <g stroke="#6c6b59" strokeWidth="1.5" strokeLinejoin="round">
      <path d="m8 47 6-4 8 3 1 7-9 2-7-4Z" fill="#9d9e83" />
      <path d="m41 47 8-4 7 4 2 5-8 3-8-2Z" fill="#b8b49a" />
      <path d="m23 52 9-3 9 4-2 6-12 1-6-4Z" fill="#b0b099" />
    </g>
    <path d="m16 42 34 9-3 7-34-10Z" fill="#805737" stroke="#5e422e" strokeWidth="1.7" strokeLinejoin="round" />
    <path d="m18 53 27-14 5 7-29 14Z" fill="#a57749" stroke="#684a31" strokeWidth="1.7" strokeLinejoin="round" />
    <path d="m21 53 20-10M20 45l23 7" stroke="#d0a06a" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M32 7c3 10 12 12 12 23 0 2-.4 4-1 6 4-3 6-5 6-8 7 14-2 23-16 23-13 0-22-8-19-19 1-5 5-8 8-12-1 6 0 9 2 10 6-8 7-15 8-23Z" fill="#d88939" stroke="#986039" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M32 25c1 8 8 10 8 17 0 5-4 8-8 8-5 0-9-3-9-8 0-4 3-7 6-10 0 3 1 4 2 5 2-4 2-8 1-12Z" fill="#f0c96d" />
    <path d="M31 40c-4 4-4 9 1 10 6 0 5-6-1-10Z" fill="#fff0b1" />
    <path d="m45 13 1-3M19 11l-1-3" stroke="#b39260" strokeWidth="1.5" strokeLinecap="round" />
  </svg>;
}
