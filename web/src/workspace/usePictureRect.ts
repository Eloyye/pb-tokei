import { type RefObject, useLayoutEffect, useState } from "react";

export interface PictureRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where the picture sits inside the `<video>` box once letterboxed, kept current on resize. */
export function usePictureRect(videoRef: RefObject<HTMLVideoElement | null>): PictureRect | null {
  const [rect, setRect] = useState<PictureRect | null>(null);
  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const measure = () => {
      const { clientWidth: bw, clientHeight: bh, videoWidth: vw, videoHeight: vh } = video;
      if (!vw || !vh || !bw || !bh) return setRect(null);
      const scale = Math.min(bw / vw, bh / vh);
      const width = vw * scale;
      const height = vh * scale;
      setRect({
        left: video.offsetLeft + (bw - width) / 2,
        top: video.offsetTop + (bh - height) / 2,
        width,
        height,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(video);
    video.addEventListener("loadedmetadata", measure);
    return () => {
      observer.disconnect();
      video.removeEventListener("loadedmetadata", measure);
    };
  }, [videoRef]);
  return rect;
}
