import type { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import type { DeviceBuildSummary } from '@sim/shared';
import type { DeviceBuildRecord, Orchestrator } from '../orchestrator.js';
import { log, warn } from '../log.js';

export interface DeviceBuildRouterOptions {
  platformToken: string | null;
  maxBuildBodyBytes: number;
}

export function deviceBuildRouter(
  orch: Orchestrator,
  options: DeviceBuildRouterOptions,
): Router {
  const router = express.Router();

  const requirePlatformToken = (req: Request, res: Response, next: NextFunction): void => {
    if (!options.platformToken) {
      next();
      return;
    }
    const provided = req.header('x-platform-token');
    if (provided !== options.platformToken) {
      res.status(401).json({ error: 'invalid X-Platform-Token' });
      return;
    }
    next();
  };

  router.use(requirePlatformToken);

  router.post(
    '/',
    express.raw({ type: '*/*', limit: options.maxBuildBodyBytes }),
    (req: Request, res: Response) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'missing tarball body' });
        return;
      }

      const scheme = req.header('x-build-scheme') || undefined;
      const bundleId = req.header('x-build-bundle-id') || undefined;
      const build = orch.createDeviceBuild(body.toString('base64'), { scheme, bundleId });
      log(`Device build requested ${build.buildId.slice(0, 8)} (${body.length} bytes)`);
      res.status(202).json(toSummary(build, req));
    },
  );

  router.get('/:id', (req: Request<{ id: string }>, res: Response) => {
    const build = orch.getDeviceBuild(req.params.id);
    if (!build) {
      res.status(404).json({ error: 'device build not found' });
      return;
    }
    res.json(toSummary(build, req));
  });

  router.get('/:id/ipa', (req: Request<{ id: string }>, res: Response) => {
    const build = orch.getDeviceBuild(req.params.id);
    if (!build) {
      res.status(404).json({ error: 'device build not found' });
      return;
    }
    if (build.state !== 'succeeded') {
      res.status(409).json({ error: 'device build is not ready', state: build.state });
      return;
    }
    const artifact = orch.getDeviceBuildArtifact(req.params.id);
    if (!artifact) {
      res.status(404).json({ error: 'IPA artifact expired or missing' });
      return;
    }

    const name = `${sanitizeFileName(build.scheme ?? 'BotflowApp')}.ipa`;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Length', String(artifact.length));
    res.end(artifact);
  });

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number; statusCode?: number }).status ??
      (err as { status?: number; statusCode?: number }).statusCode ??
      500;
    const message = (err as { message?: string }).message ?? 'internal error';
    if (status >= 500) warn(`device build route error: ${message}`);
    res.status(status).json({ error: message });
  });

  return router;
}

function toSummary(build: DeviceBuildRecord, req: Request): DeviceBuildSummary {
  return {
    buildId: build.buildId,
    state: build.state,
    createdAt: build.createdAt,
    updatedAt: build.updatedAt,
    hostId: build.hostId,
    scheme: build.scheme,
    bundleId: build.bundleId,
    durationMs: build.durationMs,
    unsigned: build.unsigned,
    diagnostics: build.diagnostics,
    logs: build.logs,
    error: build.error,
    ipaUrl: build.state === 'succeeded' ? absoluteUrl(req, `/api/device-builds/${build.buildId}/ipa`) : null,
  };
}

function absoluteUrl(req: Request, path: string): string {
  const proto = req.header('x-forwarded-proto') ?? req.protocol;
  const host = req.header('x-forwarded-host') ?? req.header('host') ?? 'localhost';
  return `${proto}://${host}${path}`;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'BotflowApp';
}
