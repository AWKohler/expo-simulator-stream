# Golden-image build runbook (manual — Phase 1)

This runbook bakes a "golden" tart VM image that has Xcode + iOS simulator
runtime + our host-agent + Tailscale already installed and configured to
register with the controller on boot. The `vm-manager` service then clones
this golden image per session.

Phase 1 keeps this manual. Phase 2 automates it via `infra/vm/bake-golden.sh`.

## Prerequisites on the bare-metal Mac

- Apple Silicon (M1/M2/M3). Tart will not run on Intel.
- macOS 13+ (Tahoe verified). Virtualization.framework support.
- Free disk ≥ 145GB. Cirrus' pre-baked Xcode image is ~140GB; pulling it
  without that headroom leaves you stuck.
- Homebrew installed.
- A Tailscale auth key (recommend: **reusable + ephemeral**, so dead VM
  clones auto-evict from your tailnet). Keep it OUT of this repo.

## One-time tart install

```bash
brew install cirruslabs/cli/tart
tart --version          # confirm ≥ 2.x
df -k / | tail -1       # confirm ≥ 145GB free
```

## Step 1 — Pull the Cirrus base image

```bash
tart clone ghcr.io/cirruslabs/macos-sequoia-xcode:latest base-xcode
```

This is the ~140GB pull. Expect ~15 min on a fast link. After it lands:

```bash
tart list   # base-xcode should appear with size ~140GB
```

## Step 2 — Boot the base, SSH in, install our additions

In shell A:

```bash
tart run base-xcode --no-graphics
```

Wait until the VM is fully booted (`tart ip base-xcode` resolves).

In shell B:

```bash
VM_IP=$(tart ip base-xcode)
ssh admin@$VM_IP                    # default password: admin
```

Inside the VM (over SSH):

```bash
# Node 22 via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
exec $SHELL
nvm install 22 && nvm alias default 22

# pnpm
npm install -g pnpm

# iOS Development Bridge — required for touch/swipe/key input
brew tap facebook/fb
brew install idb-companion

# XcodeGen — required by our build pipeline
brew install xcodegen

# Tailscale
brew install --cask tailscale
```

## Step 3 — rsync our host-agent into the VM

In shell C (on the bare-metal Mac, NOT inside the VM):

```bash
# Adjust source path to your local expo-stream checkout
rsync -avz --exclude node_modules --exclude dist \
  /path/to/expo-stream/packages/ \
  admin@$VM_IP:/Users/admin/expo-stream/packages/

rsync -avz \
  /path/to/expo-stream/package.json \
  /path/to/expo-stream/pnpm-workspace.yaml \
  /path/to/expo-stream/pnpm-lock.yaml \
  /path/to/expo-stream/tsconfig.base.json \
  admin@$VM_IP:/Users/admin/expo-stream/
```

Back inside the VM:

```bash
cd ~/expo-stream
pnpm install
# Build the native framebuffer capturer once (the binary is host-arch-specific,
# so the VM needs its own build — don't copy build/ from the bare-metal Mac).
cd packages/host-agent/native/framebuffer-capturer
./build.sh   # whatever your existing build invocation is
```

## Step 4 — Install the launchd unit + per-VM bootstrap

The launchd plist runs our host-agent on every boot. The per-VM bootstrap
script reads a Tailscale auth key from `/etc/sim-vm/authkey` (written by
`vm-manager` before starting the VM) and joins the tailnet.

Inside the VM, create `/etc/sim-vm/` so the boot script can find its config:

```bash
sudo mkdir -p /etc/sim-vm
sudo chown admin:staff /etc/sim-vm
sudo chmod 750 /etc/sim-vm
```

Then create the boot bootstrap script `/usr/local/sbin/sim-vm-boot.sh`:

```bash
sudo tee /usr/local/sbin/sim-vm-boot.sh >/dev/null <<'EOF'
#!/bin/bash
# Reads /etc/sim-vm/authkey (placed by vm-manager) and joins Tailscale.
# Reads /etc/sim-vm/env for CONTROLLER_URL/HOST_TOKEN/HOST_ID.
set -e
if [ -f /etc/sim-vm/authkey ]; then
  AUTHKEY=$(cat /etc/sim-vm/authkey)
  HOSTNAME=$(hostname -s)
  /Applications/Tailscale.app/Contents/MacOS/Tailscale up \
    --authkey="$AUTHKEY" --hostname="$HOSTNAME" --ephemeral=true || true
fi
EOF
sudo chmod 755 /usr/local/sbin/sim-vm-boot.sh
```

Copy the host-agent launchd plist from the repo into `~/Library/LaunchAgents/`:

```bash
mkdir -p ~/Library/LaunchAgents
cp ~/expo-stream/infra/vm/com.simstream.host-agent.plist \
   ~/Library/LaunchAgents/com.simstream.host-agent.plist
launchctl load -w ~/Library/LaunchAgents/com.simstream.host-agent.plist
```

Edit the plist's `EnvironmentVariables` block to reference per-VM env via the
`/etc/sim-vm/env` file (the launchd unit reads it on every load — see the
comments inside the plist).

## Step 5 — Stop the base, clone to `golden`, delete base

In shell A: `Ctrl-C` to stop the running base VM. Then in any shell:

```bash
tart stop base-xcode      # idempotent, in case it's still running
tart clone base-xcode golden
tart delete base-xcode    # reclaim ~140GB
tart list                 # `golden` should be the only image now
df -k / | tail -1         # expect ~85GB+ free
```

`golden` is now the immutable template. `vm-manager` clones from it; never
boot `golden` itself (a boot dirties the image and breaks reproducibility).

## Step 6 — Verify with a one-shot manual clone

```bash
# Place a Tailscale authkey for the test clone
echo "tskey-auth-..." > /tmp/sim-vm-test-authkey

# Clone + boot
tart clone golden vm-smoke
# Copy authkey + env into the VM's mountable share, then boot.
# (Phase 2 vm-manager handles this via `tart --mount`; for manual smoke
# test, ssh in after boot and place the file.)
tart run vm-smoke --memory 4096 --cpu 2 --no-graphics &
VM_PID=$!

# Wait ~30s for boot, then:
VM_IP=$(tart ip vm-smoke)
scp /tmp/sim-vm-test-authkey admin@$VM_IP:/etc/sim-vm/authkey
ssh admin@$VM_IP "sudo /usr/local/sbin/sim-vm-boot.sh"
ssh admin@$VM_IP "launchctl kickstart -k gui/$(id -u)/com.simstream.host-agent"

# From bare-metal Mac:
tailscale status | grep vm-smoke   # confirm it joined
curl -s "$CONTROLLER_HEALTH_URL"   # confirm controller saw the VM register

# Tear down
kill $VM_PID
tart stop vm-smoke
tart delete vm-smoke
```

## Troubleshooting

- **"tart: VM image larger than free disk"** — you didn't gate the pull on
  ≥145GB. `tart delete base-xcode` then start over with more headroom.
- **VM boots but host-agent never registers** — `ssh` in, `tail -f
  /tmp/sim-host.log`. Most common: wrong `CONTROLLER_URL` in `/etc/sim-vm/env`,
  or Tailscale failed to come up (check `tailscale status` inside the VM).
- **"Apple licensing — 2 VMs per host"**: irrelevant for this single-VM
  configuration; will matter when scaling past max=2.

## When to re-bake

Re-run this runbook (producing a new `golden`) whenever:
- Xcode in the VM needs to be updated.
- The host-agent's wire protocol changes in a way the controller now requires.
- Tailscale, idb_companion, or another bundled binary needs a major version bump.

`vm-manager` reads the image name from `VM_MANAGER_GOLDEN` env. If you want
versioned rollbacks, keep multiple goldens (e.g. `golden-2026-05-21`) and
flip the env to switch.
