'use client';

import { useEffect, useRef, useState } from 'react';
import type { ScreenRect, WindowInfo } from '@sim/shared';

interface Props {
  canvas: HTMLCanvasElement;
  windowInfo: WindowInfo;
  screenRect: ScreenRect;
  onSave: (rect: ScreenRect) => void;
  onCancel: () => void;
}

type Corner = 'tl' | 'tr' | 'bl' | 'br';

interface HandlePos {
  cssX: number;
  cssY: number;
}

export function CalibrationOverlay({ canvas, windowInfo, screenRect, onSave, onCancel }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<Corner | null>(null);
  const [handles, setHandles] = useState<Record<Corner, HandlePos>>(() => {
    const r = canvas.getBoundingClientRect();
    const normLeft = screenRect.left / windowInfo.w;
    const normTop = screenRect.top / windowInfo.h;
    const normRight = screenRect.right / windowInfo.w;
    const normBottom = screenRect.bottom / windowInfo.h;
    return {
      tl: { cssX: normLeft * r.width, cssY: normTop * r.height },
      tr: { cssX: normRight * r.width, cssY: normTop * r.height },
      bl: { cssX: normLeft * r.width, cssY: normBottom * r.height },
      br: { cssX: normRight * r.width, cssY: normBottom * r.height },
    };
  });

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const corner = draggingRef.current;
      if (!corner) return;
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      setHandles((h) => {
        const next: Record<Corner, HandlePos> = {
          tl: { ...h.tl },
          tr: { ...h.tr },
          bl: { ...h.bl },
          br: { ...h.br },
        };
        next[corner] = { cssX: x, cssY: y };
        // Keep the rectangle rectangular by syncing the opposite-axis handles.
        if (corner === 'tl') {
          next.tr.cssY = y;
          next.bl.cssX = x;
        } else if (corner === 'tr') {
          next.tl.cssY = y;
          next.br.cssX = x;
        } else if (corner === 'bl') {
          next.br.cssY = y;
          next.tl.cssX = x;
        } else if (corner === 'br') {
          next.bl.cssY = y;
          next.tr.cssX = x;
        }
        return next;
      });
    };
    const onUp = (): void => {
      draggingRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [canvas]);

  const handleSave = (): void => {
    const r = canvas.getBoundingClientRect();
    const newRect: ScreenRect = {
      left: (handles.tl.cssX / r.width) * windowInfo.w,
      top: (handles.tl.cssY / r.height) * windowInfo.h,
      right: (handles.br.cssX / r.width) * windowInfo.w,
      bottom: (handles.br.cssY / r.height) * windowInfo.h,
    };
    onSave(newRect);
  };

  const rectStyle: React.CSSProperties = {
    position: 'absolute',
    left: handles.tl.cssX,
    top: handles.tl.cssY,
    width: handles.br.cssX - handles.tl.cssX,
    height: handles.br.cssY - handles.tl.cssY,
    border: '2px solid var(--accent)',
    background: 'rgba(91,156,246,0.08)',
    pointerEvents: 'none',
  };

  return (
    <div ref={rootRef} className="absolute inset-0 z-10">
      <div style={rectStyle} />
      {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
        <div
          key={c}
          onMouseDown={(e) => {
            e.stopPropagation();
            draggingRef.current = c;
          }}
          className="absolute h-5.5 w-5.5 cursor-grab rounded-full border-2 border-white shadow-lg active:cursor-grabbing"
          style={{
            left: handles[c].cssX,
            top: handles[c].cssY,
            width: 22,
            height: 22,
            transform: 'translate(-50%, -50%)',
            background: 'rgba(91,156,246,0.9)',
          }}
        />
      ))}
      <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-white/10 bg-black/80 px-4 py-2.5 backdrop-blur-md">
        <p className="text-xs text-white/60">Drag corners to match the device screen edges</p>
        <button
          onClick={handleSave}
          className="rounded-md bg-blue-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-400"
        >
          Save
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-white/10 px-2.5 py-1.5 text-xs text-white/70 hover:bg-white/5"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
