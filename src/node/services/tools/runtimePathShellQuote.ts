import { shellQuote } from "@/common/utils/shell";

/**
 * Quote a path for use in runtime shell probe scripts.
 *
 * On SSH/Docker runtimes, workspacePath can be ~/... (tilde-prefixed).
 * POSIX tilde expansion does NOT occur inside single or double quotes,
 * so we must expand ~ to $HOME before quoting the rest of the path.
 *
 * Invariant: the returned string is safe for interpolation into shell scripts
 * and correctly resolves home-relative paths.
 */
export function quoteRuntimeProbePath(path: string): string {
  if (path === "~") return '"$HOME"';
  if (path.startsWith("~/")) {
    // Emit "$HOME" for shell expansion, then quote the remainder.
    const remainder = path.slice(1);
    return '"$HOME"' + shellQuote(remainder);
  }
  return shellQuote(path);
}
