# Tunnel setup — Cloudflare Tunnel + custom domain

This is a one-time setup. Once the tunnel is running, `https://sim.<yourdomain>`
will hit this Mac's local Controller + Web app.

## Prerequisites

- A domain registered on Cloudflare (or with NS records pointing at Cloudflare). Cloudflare Registrar charges ~$10/yr if you want to buy one through them.
- `brew` installed.

## 1. Install cloudflared

```bash
brew install cloudflared
```

## 2. Log in (one-time browser flow)

```bash
cloudflared tunnel login
```

This opens a browser. Pick the zone for your domain. cloudflared writes a cert
to `~/.cloudflared/cert.pem`.

## 3. Create a tunnel

```bash
cloudflared tunnel create sim-poc
```

Output includes the tunnel ID and the path to the credentials JSON
(`~/.cloudflared/<id>.json`).

## 4. Configure ingress

```bash
cp infra/cloudflared-config.example.yml infra/cloudflared-config.yml
```

Edit `infra/cloudflared-config.yml`:

- Replace `<tunnel-id>` (two places).
- Replace `sim.example.com` with your actual hostname (e.g. `sim.aronne.dev`).

## 5. Point DNS at the tunnel

```bash
cloudflared tunnel route dns sim-poc sim.<yourdomain>
```

This creates a CNAME `sim.<yourdomain>` → `<tunnel-id>.cfargotunnel.com`.

## 6. Run

In one terminal:

```bash
cloudflared tunnel --config infra/cloudflared-config.yml run sim-poc
```

In other terminals (or via `pnpm dev` from the repo root):

```bash
pnpm dev:controller   # localhost:8080
pnpm dev:host         # connects out to localhost:8080
pnpm dev:web          # localhost:3000
```

## 7. Verify

Open `https://sim.<yourdomain>` from a phone on LTE. The launch button should
provision a session through the tunnel.

## Run as a service (later)

```bash
sudo cloudflared service install
```

This sets up a launchd plist that auto-starts the tunnel on boot. The
controller and host-agent can be managed similarly with `launchd` or `pm2`.

## Multi-Mac later

When you add a second Mac, the simplest path is:

1. Run another host-agent on the new Mac.
2. Point its `CONTROLLER_URL` env at the Controller's reachable address (either
   the Tailscale IP for the Controller host, or a second tunnel ingress).
3. The Controller pools both hosts automatically — no orchestrator code changes.

If the Controller moves off this Mac, point all host agents at the new
Controller's address. No host-side config needs to change otherwise.
