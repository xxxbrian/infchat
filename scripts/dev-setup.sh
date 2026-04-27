#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script currently supports macOS only." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to install mise." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ensure_line() {
  local file="$1"
  local line="$2"

  mkdir -p "$(dirname "$file")"
  touch "$file"

  if ! grep -Fqx "$line" "$file"; then
    printf '\n%s\n' "$line" >> "$file"
  fi
}

find_mise() {
  if command -v mise >/dev/null 2>&1; then
    command -v mise
    return 0
  fi

  if [[ -x "$HOME/.local/bin/mise" ]]; then
    printf '%s\n' "$HOME/.local/bin/mise"
    return 0
  fi

  return 1
}

SHOULD_CONFIG_SHELL=0
MISE_BIN="$(find_mise || true)"

if [[ -z "$MISE_BIN" ]]; then
  echo "Installing mise via https://mise.run/"
  curl -fsSL https://mise.run | sh
  MISE_BIN="$HOME/.local/bin/mise"
  SHOULD_CONFIG_SHELL=1
fi

if [[ ! -x "$MISE_BIN" ]]; then
  echo "mise installation did not produce an executable binary." >&2
  exit 1
fi

if [[ "$SHOULD_CONFIG_SHELL" -eq 1 ]]; then
  ensure_line "$HOME/.zprofile" 'export PATH="$HOME/.local/bin:$PATH"'
  ensure_line "$HOME/.zshrc" "eval \"\$($MISE_BIN activate zsh)\""
fi

echo "Using mise binary: $MISE_BIN"
echo "Installing tools from $REPO_ROOT/mise.toml"
"$MISE_BIN" install -C "$REPO_ROOT" -y

echo "Installing prek git hooks"
"$MISE_BIN" exec -C "$REPO_ROOT" -y -- \
  prek install --prepare-hooks --hook-type pre-commit --hook-type commit-msg

echo "Setup complete."
