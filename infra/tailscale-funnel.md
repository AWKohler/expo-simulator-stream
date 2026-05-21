# Tailscale Funnel setup

For PoC: expose the local Controller over Tailscale Funnel so the
webcontainer-ide (running on Vercel or locally) can reach it from anywhere. No
port forwarding, no custom domain — accessed via the Mac's stable `.ts.net`
hostname.

> Custom domain via Cloudflare Tunnel is documented separately in
> `infra/README.md`. Funnel is the quickest path; Cloudflare is the path for
> production once the user moves DNS off Vercel.

## Prerequisites

- Tailscale installed and the Mac signed in.
- The Mac's Funnel quota enabled (free tier includes Funnel since 2023).

## One-time setup

```bash
# Expose port 8080 as HTTPS on port 443 (Funnel default).
tailscale serve --bg --https 443 http://localhost:8080

# Turn on Funnel — makes the .ts.net URL publicly reachable.
tailscale funnel 443 on
```

Verify:

```bash
# From any network — substitute your Funnel hostname (see `tailscale status`).
curl "https://${TS_FUNNEL_HOST}/health"  # e.g. <machine>.<tailnet>.ts.net
```

You should see the Controller's health JSON.

## Inspect / modify

```bash
tailscale serve status
tailscale funnel status
```

## Tear down

```bash
tailscale funnel 443 off
tailscale serve reset
```

## Caveats

- Funnel only allows ports 443, 8443, and 10000. We use 443.
- Latency is roughly the round-trip to the closest Tailscale DERP relay. For
  WebSocket frames this typically adds 30–80 ms.
- The hostname is fixed to `<your-machine>.<tailnet>.ts.net` — no custom domain.

## Why not Cloudflare Tunnel here

The user's domain is currently on Vercel, so DNS would need to be migrated to
Cloudflare to use a custom domain on a Cloudflare Tunnel. That's deferred. The
Funnel path works for the PoC and for an indefinite period.
