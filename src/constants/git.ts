/**
 * Protocol schemes Git routes through SSH transport. Git's `get_protocol()` maps the deprecated
 * `git+ssh` and `ssh+git` aliases to `PROTO_SSH`, so remotes using them behave exactly like
 * `ssh://`. Values match `URL.protocol`, which includes the trailing colon.
 */
export const SSH_PROTOCOL_SCHEMES: ReadonlySet<string> = new Set(["ssh:", "git+ssh:", "ssh+git:"]);
