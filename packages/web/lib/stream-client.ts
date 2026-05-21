'use client';

import type {
  BrowserToServer,
  ServerToBrowser,
  ScreenRect,
  WindowInfo,
  DeviceLogical,
  SessionState,
  Input,
} from '@sim/shared';

export interface StreamHandlers {
  onState: (state: SessionState, queuePosition?: number) => void;
  onCalibration: (info: { windowInfo: WindowInfo; screenRect: ScreenRect; deviceLogical: DeviceLogical }) => void;
  onFrame: (jpegBase64: string) => void;
  onStatus: (message: string) => void;
  onError: (message: string) => void;
  onOpen: () => void;
  onClose: (code: number) => void;
}

export class StreamClient {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly handlers: StreamHandlers,
  ) {}

  start(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.handlers.onOpen();
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) this.send({ type: 'ping' });
      }, 30_000);
    };

    ws.onmessage = (e) => {
      let msg: ServerToBrowser;
      try {
        msg = JSON.parse(e.data) as ServerToBrowser;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'state':
          this.handlers.onState(msg.state, msg.queuePosition);
          break;
        case 'calibration':
          this.handlers.onCalibration({
            windowInfo: msg.windowInfo,
            screenRect: msg.screenRect,
            deviceLogical: msg.deviceLogical,
          });
          break;
        case 'frame':
          this.handlers.onFrame(msg.data);
          break;
        case 'status':
          this.handlers.onStatus(msg.message);
          break;
        case 'error':
          this.handlers.onError(msg.message);
          break;
        case 'pong':
          break;
      }
    };

    ws.onclose = (e) => {
      this.cleanup();
      if (!this.closed) this.handlers.onClose(e.code);
    };
    ws.onerror = () => {
      // onclose fires next; handle there.
    };
  }

  send(msg: BrowserToServer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendInput(input: Input): void {
    this.send({ type: 'input', input });
  }

  setCalibration(screenRect: ScreenRect): void {
    this.send({ type: 'set_calibration', screenRect });
  }

  resetCalibration(): void {
    this.send({ type: 'reset_calibration' });
  }

  close(): void {
    this.closed = true;
    this.cleanup();
    this.ws?.close();
  }

  private cleanup(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
