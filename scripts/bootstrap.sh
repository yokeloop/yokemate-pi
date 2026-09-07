#!/usr/bin/env bash
# Bring a clean Ubuntu 22.04+ machine to a working yokemate instance.
# Idempotent: every step checks its own "already done" and skips. What this
# script does not do for the engineer — .env.local, the personal data
# repository home/, gh login, ssh keys and tailscale — it names in the final
# summary, which reports the state of this machine and a command per item.
set -euo pipefail

YOKEMATE_DIR="${YOKEMATE_DIR:-$HOME/yokemate}"
YOKEMATE_REMOTE="${YOKEMATE_REMOTE:-git@github.com:yokeloop/yokemate-pi.git}"
YOKEMATE_HOME_REMOTE="${YOKEMATE_HOME_REMOTE:-}"

say()  { printf '\n== %s\n' "$*"; }
skip() { printf '   %s — already in place\n' "$*"; }

github_ssh_ok() {
  ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -T git@github.com 2>&1 |
    grep -q 'successfully authenticated'
}

if ! command -v apt-get >/dev/null 2>&1; then
  echo "bootstrap.sh targets Ubuntu 22.04+ (apt not found on this system) — aborting" >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

APT_UPDATED=""
apt_install() {
  if [ -z "$APT_UPDATED" ]; then
    $SUDO apt-get update -qq
    APT_UPDATED=1
  fi
  $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
}

say "locales (ru_RU.UTF-8, en_US.UTF-8)"
if locale -a 2>/dev/null | grep -qi 'ru_RU.utf8' && locale -a 2>/dev/null | grep -qi 'en_US.utf8'; then
  skip "locales"
else
  apt_install locales
  $SUDO locale-gen ru_RU.UTF-8 en_US.UTF-8
  $SUDO update-locale LANG=en_US.UTF-8
fi

say "base packages (git, curl, build-essential, jq)"
missing=""
for pkg in git curl build-essential jq; do
  dpkg -s "$pkg" >/dev/null 2>&1 || missing="$missing $pkg"
done
if [ -z "$missing" ]; then
  skip "base packages"
else
  # shellcheck disable=SC2086
  apt_install $missing
fi

say "node >= 22 (NodeSource) and pnpm (corepack)"
node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
fi
if [ "$node_major" -ge 22 ]; then
  skip "node $(node -v)"
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
  apt_install nodejs
fi
if command -v pnpm >/dev/null 2>&1; then
  skip "pnpm $(pnpm --version)"
else
  $SUDO corepack enable
fi

say "gh (official GitHub apt repo)"
if command -v gh >/dev/null 2>&1; then
  skip "gh $(gh --version | head -1)"
else
  $SUDO mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg |
    $SUDO tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  $SUDO chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" |
    $SUDO tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  APT_UPDATED=""
  apt_install gh
fi

say "claude code"
if command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ]; then
  skip "claude"
else
  curl -fsSL https://claude.ai/install.sh | bash
fi
export PATH="$HOME/.local/bin:$PATH"

say "herdr"
if command -v herdr >/dev/null 2>&1; then
  skip "herdr $(herdr --version 2>/dev/null || true)"
else
  if curl -fsSL https://herdr.dev/install.sh | sh; then
    :
  else
    echo "   WARNING: herdr install failed — /do tabs will not run on this machine; the rest continues" >&2
  fi
fi

say "\$HOME/.claude/settings.json (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS)"
settings="$HOME/.claude/settings.json"
if [ ! -f "$settings" ]; then
  mkdir -p "$HOME/.claude"
  printf '{"env":{"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS":"1"}}\n' > "$settings"
elif [ "$(jq -r '.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS // empty' "$settings")" = "1" ]; then
  skip "settings.json"
else
  tmp="$(mktemp)"
  jq '.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"' "$settings" > "$tmp"
  mv "$tmp" "$settings"
fi

say "yokemate clone at $YOKEMATE_DIR"
if [ -d "$YOKEMATE_DIR/.git" ]; then
  git -C "$YOKEMATE_DIR" pull --ff-only
else
  git clone "$YOKEMATE_REMOTE" "$YOKEMATE_DIR"
fi
(cd "$YOKEMATE_DIR" && pnpm install)

say "personal data repository at $YOKEMATE_DIR/home"
home_dir="$YOKEMATE_DIR/home"
if [ -d "$home_dir/.git" ]; then
  skip "home/"
elif [ -n "$YOKEMATE_HOME_REMOTE" ]; then
  git clone "$YOKEMATE_HOME_REMOTE" "$home_dir"
else
  echo "   YOKEMATE_HOME_REMOTE not set — personal data skipped, home/ not created (named in the summary below)"
fi
if [ -d "$home_dir/.git" ]; then
  [ -f "$home_dir/.gitattributes" ] || printf 'journal/*.md merge=union\n' > "$home_dir/.gitattributes"
  [ -f "$home_dir/projects.json" ] || printf '[]\n' > "$home_dir/projects.json"
  mkdir -p "$home_dir/journal" "$home_dir/knowledge" "$home_dir/notes"
fi

say "user-level MCP (youtrack trackers)"
env_local="$YOKEMATE_DIR/.env.local"
if [ ! -f "$env_local" ]; then
  echo "   .env.local not found — MCP registration skipped (re-run after placing it)"
elif ! command -v claude >/dev/null 2>&1; then
  echo "   claude not on PATH — MCP registration skipped (open a new shell and re-run)"
else
  set -a
  # shellcheck source=/dev/null
  . "$env_local"
  set +a
  register_mcp() {
    name="$1" url="$2" token="$3"
    if [ -z "$url" ] || [ -z "$token" ]; then
      echo "   $name: variables missing in .env.local — skipped"
      return
    fi
    if claude mcp get "$name" >/dev/null 2>&1; then
      skip "$name"
    else
      claude mcp add --scope user --transport http "$name" "$url/mcp" \
        --header "Authorization: Bearer $token"
    fi
  }
  while IFS='=' read -r key _ || [ -n "$key" ]; do
    case "$key" in YT_*_URL) ;; *) continue ;; esac
    base="${key%_URL}"
    name="youtrack-$(printf '%s' "${base#YT_}" | tr 'A-Z_' 'a-z-')"
    eval "url=\${$key:-}; token=\${${base}_TOKEN:-}"
    register_mcp "$name" "$url" "$token"
  done < "$env_local"
fi

say "project clones and passports (import-projects)"
if [ ! -f "$env_local" ]; then
  echo "   .env.local not found — import skipped (place it and run: pnpm import-projects)"
elif [ ! -d "$YOKEMATE_DIR/home/.git" ]; then
  echo "   home/ not set up — import skipped (see the summary below)"
elif ! github_ssh_ok; then
  echo "   ssh key not registered on github — import skipped (register it and run: pnpm import-projects)"
else
  (cd "$YOKEMATE_DIR" && pnpm import-projects)
fi

say "done — what this machine still needs"
manual=()

[ -f "$env_local" ] || manual+=(".env.local: copy it from a live machine into $YOKEMATE_DIR")

if [ ! -d "$YOKEMATE_DIR/home/.git" ]; then
  manual+=("home/: personal data (knowledge, journal, notes, projects.json) is not set up.
       Already have a data repository:  YOKEMATE_HOME_REMOTE=<url> ./scripts/bootstrap.sh
       Need a new one, after gh auth login:
         gh repo create <name> --private && git clone <url-of-that-repo> $YOKEMATE_DIR/home
       then re-run ./scripts/bootstrap.sh")
fi

gh auth status >/dev/null 2>&1 || manual+=("gh auth login")

github_ssh_ok || manual+=("ssh key: generate it and register on the git hostings")

if ! command -v tailscale >/dev/null 2>&1; then
  manual+=("tailscale: install it, then tailscale up")
elif ! tailscale status >/dev/null 2>&1; then
  manual+=("tailscale: installed but not connected — tailscale up")
fi

if [ "${#manual[@]}" -eq 0 ]; then
  echo "   nothing — this machine is ready"
else
  printf '   - %s\n' "${manual[@]}"
fi
