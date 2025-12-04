# Shell Environment (`~/.mux/bashrc`)

Customize the shell environment for agent bash commands by creating a `~/.mux/bashrc` file.

## Why This Exists

When mux runs bash commands (via `bash -c "command"`), the shell is **non-interactive** and **doesn't source `~/.bashrc`**. Most users have interactivity guards in their bashrc that skip content in non-interactive shells:

```bash
# Common pattern in ~/.bashrc that skips setup for non-interactive shells
[[ $- != *i* ]] && return
```

This means:

- **Launching from Applications** — PATH is minimal (`/usr/bin:/bin:/usr/sbin:/sbin`)
- **Nix/direnv users** — Shell customizations aren't applied
- **Homebrew/pyenv/rbenv** — Tools not in PATH

The `~/.mux/bashrc` file is **always sourced** before every bash command, giving you a place to set up the environment reliably.

## Setup

Create `~/.mux/bashrc`:

```bash
mkdir -p ~/.mux
touch ~/.mux/bashrc
```

Add your shell customizations:

```bash
# ~/.mux/bashrc

# Add Homebrew to PATH (macOS)
eval "$(/opt/homebrew/bin/brew shellenv)"

# Add ~/bin to PATH
export PATH="$HOME/bin:$PATH"
```

## Examples

### Nix Users

```bash
# ~/.mux/bashrc

# Source nix profile
if [ -e "$HOME/.nix-profile/etc/profile.d/nix.sh" ]; then
  . "$HOME/.nix-profile/etc/profile.d/nix.sh"
fi

# Enable direnv (auto-loads .envrc per directory)
eval "$(direnv hook bash)"
```

### Python (pyenv)

```bash
# ~/.mux/bashrc
export PYENV_ROOT="$HOME/.pyenv"
export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init -)"
```

### Node.js (nvm)

```bash
# ~/.mux/bashrc
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
```

### Ruby (rbenv)

```bash
# ~/.mux/bashrc
eval "$(rbenv init -)"
```

### Multiple Tools (asdf)

```bash
# ~/.mux/bashrc
. "$HOME/.asdf/asdf.sh"
```

## Behavior

- **Sourced before every bash command** — including init hooks
- **Silently skipped if missing** — no bashrc file = no effect
- **Errors propagate** — if your bashrc has errors, they appear in command output
- **SSH workspaces** — the remote `~/.mux/bashrc` is sourced (you manage it on the remote host)

## Comparison with Init Hooks

| Feature | `~/.mux/bashrc`       | `.mux/init`                |
| ------- | --------------------- | -------------------------- |
| When    | Every bash command    | Once at workspace creation |
| Scope   | Global (all projects) | Per-project                |
| Purpose | Shell environment     | Project build/install      |
| Errors  | Command fails         | Logged, non-blocking       |

Use **bashrc** for environment (PATH, tools, direnv hooks).
Use **init hooks** for project setup (install dependencies, build).

## Troubleshooting

### Commands Not Finding Tools

If tools aren't found, check that bashrc is being sourced:

```bash
# In mux, run:
echo "bashrc: $MUX_BASHRC_SOURCED"
```

If empty, your bashrc might not exist. If you want to confirm it's being sourced, add to your bashrc:

```bash
# ~/.mux/bashrc
export MUX_BASHRC_SOURCED=1
```

### Bashrc Errors

Errors in your bashrc will cause commands to fail. Test your bashrc:

```bash
bash -c '[ -f "$HOME/.mux/bashrc" ] && . "$HOME/.mux/bashrc" && echo ok'
```

### Performance

The bashrc runs before every command. Keep it fast:

- Avoid expensive operations (network calls, slow init scripts)
- Use lazy loading where possible
- Profile with `time bash -c '. ~/.mux/bashrc'`

## Related

- [Init Hooks](./init-hooks.md) — Per-project initialization scripts
- [Project Secrets](./project-secrets.md) — Environment variables for API keys
