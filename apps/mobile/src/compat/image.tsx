import type { CSSProperties, ImgHTMLAttributes } from "react";

type BundledImage = string | { src: string; width?: number; height?: number } | { default: { src: string; width?: number; height?: number } };
type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: BundledImage; alt: string; unoptimized?: boolean; priority?: boolean; fill?: boolean;
};

/** Bundled images don't require Next's remote image optimizer. */
export default function Image({ src, alt, unoptimized: _unoptimized, priority, fill, style, ...props }: Props) {
  void _unoptimized;
  const asset = typeof src === "string" ? { src } : "default" in src ? src.default : src;
  const fillStyle: CSSProperties = fill ? { position: "absolute", inset: 0, width: "100%", height: "100%" } : {};
  // eslint-disable-next-line @next/next/no-img-element -- Assets are local files in the installed application.
  return <img {...props} alt={alt} src={asset.src} width={props.width ?? asset.width} height={props.height ?? asset.height}
    loading={priority ? "eager" : props.loading ?? "lazy"} fetchPriority={priority ? "high" : props.fetchPriority} decoding="async" style={{ ...fillStyle, ...style }} />;
}
