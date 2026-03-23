import { useCallback, useEffect, useRef, useState } from 'react';

interface UseResizableOptions {
  /** Initial width in px */
  initial: number;
  min: number;
  max: number;
  storageKey?: string;
}

/**
 * Returns [width, dragHandleProps] for a resizable panel.
 * Drag handle should be placed on the right edge of the panel.
 */
export function useResizable({ initial, min, max, storageKey }: UseResizableOptions) {
  const [width, setWidth] = useState<number>(() => {
    if (storageKey) {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const n = parseInt(saved, 10);
        if (!isNaN(n)) return Math.max(min, Math.min(max, n));
      }
    }
    return initial;
  });

  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      startX.current = e.clientX;
      startWidth.current = width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width]
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const next = Math.max(min, Math.min(max, startWidth.current + delta));
      setWidth(next);
      if (storageKey) localStorage.setItem(storageKey, String(Math.round(next)));
    };

    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [min, max, storageKey]);

  const dragHandleProps = {
    onMouseDown,
    style: { cursor: 'col-resize' } as React.CSSProperties,
  };

  return [width, dragHandleProps] as const;
}
