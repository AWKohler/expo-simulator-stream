'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScreenRect, WindowInfo, DeviceLogical } from '@sim/shared';
import { StreamClient } from '@/lib/stream-client';
import { getWSBase } from '@/lib/env';
import { CalibrationOverlay } from './CalibrationOverlay';

export interface ViewportProps {
  sessionId: string;
  onStateChange: (state: string, queuePosition?: number) => void;
  onLog: (msg: string, level?: 'info' | 'ok' | 'warn' | 'err') => void;
}

export function SimulatorViewport({ sessionId, onStateChange, onLog }: ViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const clientRef = useRef<StreamClient | null>(null);
  const frameCountRef = useRef(0);
  const fpsTimeRef = useRef(Date.now());

  const [fps, setFps] = useState(0);
  const [windowInfo, setWindowInfo] = useState<WindowInfo | null>(null);
  const [screenRect, setScreenRect] = useState<ScreenRect | null>(null);
  const [deviceLogical, setDeviceLogical] = useState<DeviceLogical | null>(null);
  const [calOpen, setCalOpen] = useState(false);

  // ── WebSocket lifecycle ────────────────────────────────────────────────────
  useEffect(() => {
    const url = `${getWSBase()}/ws/session/${sessionId}`;
    const client = new StreamClient(url, {
      onOpen: () => onLog(`Connected to ${url}`, 'ok'),
      onClose: (code) => onLog(`WS closed (${code})`, code === 1000 ? 'info' : 'warn'),
      onState: (state, qp) => onStateChange(state, qp),
      onCalibration: ({ windowInfo, screenRect, deviceLogical }) => {
        setWindowInfo(windowInfo);
        setScreenRect(screenRect);
        setDeviceLogical(deviceLogical);
        onLog(
          `Calibration: window ${windowInfo.w}×${windowInfo.h}, device ${deviceLogical.w}×${deviceLogical.h}`,
        );
      },
      onFrame: (b64) => drawFrame(b64),
      onStatus: (m) => onLog(m),
      onError: (m) => onLog(m, 'err'),
    });
    clientRef.current = client;
    client.start();

    return () => {
      client.close();
      clientRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ── Frame drawing ──────────────────────────────────────────────────────────
  const drawFrame = useCallback((b64: string) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      ctx.drawImage(img, 0, 0);
      frameCountRef.current++;
      const now = Date.now();
      const elapsed = now - fpsTimeRef.current;
      if (elapsed >= 1000) {
        setFps(Math.round((frameCountRef.current * 1000) / elapsed));
        frameCountRef.current = 0;
        fpsTimeRef.current = now;
      }
    };
    img.src = `data:image/jpeg;base64,${b64}`;
  }, []);

  // ── Input handling ─────────────────────────────────────────────────────────
  const normPos = useCallback((e: { clientX: number; clientY: number }): { normX: number; normY: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { normX: 0, normY: 0 };
    const r = canvas.getBoundingClientRect();
    return {
      normX: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      normY: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  }, []);

  const showRipple = useCallback((clientX: number, clientY: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r = document.createElement('div');
    r.className = 'ripple';
    const rect = wrap.getBoundingClientRect();
    r.style.left = `${clientX - rect.left}px`;
    r.style.top = `${clientY - rect.top}px`;
    wrap.appendChild(r);
    requestAnimationFrame(() => r.classList.add('pop'));
    setTimeout(() => r.remove(), 400);
  }, []);

  const dragRef = useRef<{ pos: { normX: number; normY: number }; clientX: number; clientY: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleDown = (e: MouseEvent): void => {
      if (calOpen) return;
      e.preventDefault();
      dragRef.current = { pos: normPos(e), clientX: e.clientX, clientY: e.clientY };
    };
    const handleUp = (e: MouseEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      const end = normPos(e);
      const dx = end.normX - drag.pos.normX;
      const dy = end.normY - drag.pos.normY;
      const client = clientRef.current;
      if (!client) return;
      if (Math.hypot(dx, dy) < 0.015) {
        showRipple(e.clientX, e.clientY);
        client.sendInput({ kind: 'tap', normX: end.normX, normY: end.normY });
      } else {
        client.sendInput({
          kind: 'swipe',
          startX: drag.pos.normX,
          startY: drag.pos.normY,
          endX: end.normX,
          endY: end.normY,
        });
      }
    };
    const handleWheel = (e: WheelEvent): void => {
      e.preventDefault();
      if (calOpen) return;
      const { normX, normY } = normPos(e);
      clientRef.current?.sendInput({
        kind: 'scroll',
        normX,
        normY,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
      });
    };
    const handleCtx = (e: MouseEvent): void => e.preventDefault();

    canvas.addEventListener('mousedown', handleDown);
    window.addEventListener('mouseup', handleUp);
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('contextmenu', handleCtx);

    return () => {
      canvas.removeEventListener('mousedown', handleDown);
      window.removeEventListener('mouseup', handleUp);
      canvas.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('contextmenu', handleCtx);
    };
  }, [calOpen, normPos, showRipple]);

  // ── Calibration handlers ───────────────────────────────────────────────────
  const handleSaveCalibration = (rect: ScreenRect): void => {
    clientRef.current?.setCalibration(rect);
    setCalOpen(false);
    onLog('Calibration saved', 'ok');
  };
  const handleResetCalibration = (): void => {
    clientRef.current?.resetCalibration();
    onLog('Calibration reset');
  };

  return (
    <div className="flex h-full w-full items-center justify-center">
      <div ref={wrapRef} className="relative">
        <canvas
          ref={canvasRef}
          className="block max-h-[calc(100vh-52px)] max-w-full cursor-crosshair select-none rounded-xl shadow-[0_0_0_1px_rgba(255,255,255,0.06),_0_24px_80px_rgba(0,0,0,0.6)]"
          style={{ touchAction: 'none' }}
        />
        <div className="pointer-events-none absolute right-2.5 top-2.5 rounded-md bg-black/55 px-2 py-0.5 font-mono text-[11px] text-emerald-400 backdrop-blur">
          {fps} fps
        </div>

        {windowInfo && screenRect && (
          <div className="absolute bottom-3 left-3 flex gap-2">
            <button
              onClick={() => setCalOpen((o) => !o)}
              className="rounded-md border border-white/10 bg-black/55 px-2.5 py-1 text-xs text-white/80 backdrop-blur hover:bg-black/70"
            >
              {calOpen ? 'Close calibrate' : 'Calibrate'}
            </button>
            <button
              onClick={handleResetCalibration}
              className="rounded-md border border-white/10 bg-black/55 px-2.5 py-1 text-xs text-white/80 backdrop-blur hover:bg-black/70"
            >
              Reset cal
            </button>
          </div>
        )}

        {calOpen && windowInfo && screenRect && canvasRef.current && (
          <CalibrationOverlay
            canvas={canvasRef.current}
            windowInfo={windowInfo}
            screenRect={screenRect}
            onSave={handleSaveCalibration}
            onCancel={() => setCalOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
