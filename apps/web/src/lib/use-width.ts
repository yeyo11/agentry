import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * The width a chart can use, measured. Charts draw at the width they get instead of scaling a
 * viewBox: scaled, their text shrinks to nothing on a phone and grows past the page's on a wide
 * screen.
 */
export function useWidth<T extends HTMLElement = HTMLDivElement>(min: number, initial = 640): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.max(min, Math.floor(el.clientWidth)));
    const observer = new ResizeObserver(([entry]) => entry && setWidth(Math.max(min, Math.floor(entry.contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, [min]);
  return [ref, width];
}
