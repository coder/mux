---
title: SSH Runtime
description: Run agents on remote hosts over SSH for security and performance
---

mux supports using remote hosts over SSH for workspaces. When configured, all tool operations will
execute over SSH and the agent is securely isolated from your local machine.

Our security architecture considers the remote machine potentially hostile. No keys or credentials are implicitly transferred there—just the git archive and [Project Secrets](/project-secrets).

We highly recommend using SSH workspaces for an optimal experience:

- **Security**: Prompt injection risk is contained to the credentials / files on the remote machine.
  - SSH remotes pair nicely with [agentic git identities](/agentic-git-identity)
- **Performance**: Run many, many agents in parallel while maintaining good battery life and UI performance

![ssh workspaces](../img/new-workspace-ssh.webp)

The Host can be:

- a hostname (e.g. `my-server.com`)
- a username and hostname (e.g. `user@my-server.com`)
- an alias from your `~/.ssh/config`, e.g. `my-server`
- anything that passes through `ssh <host>` can be used as a host

We delegate SSH configuration to the system's `ssh` command, so you can set up advanced
configuration for your agent host in your local `~/.ssh/config` file.

Here's an example of a config entry:

```
Host ovh-1
	HostName 148.113.1.1
	User root
```

## Authentication

<Info>As we delegate to `ssh`, this is really an abbreviated reference of how `ssh` authenticates.</Info>

There are a few practical ways to set up authentication.

### Local default keys

`ssh` will check these locations by default:

```
~/.ssh/id_rsa
~/.ssh/id_ecdsa
~/.ssh/id_ecdsa_sk
~/.ssh/id_ed25519
~/.ssh/id_ed25519_sk
```

### SSH Agent

If you have an SSH agent running, you can add your key:

```
ssh-add ~/.ssh/my_key_ecdsa
```

and `ssh` will use it to authenticate.

### Config

You can also configure authentication in your `~/.ssh/config` file.

```
Host my-server
	HostName 148.113.1.1
	User root
	IdentityFile ~/.ssh/id_rsa
```

## Coder Workspaces

If you're using [Coder Workspaces](https://coder.com/docs), you can use an existing Workspace
as a mux agent host:

1. Run `coder config-ssh`
2. Use `coder.<workspace-name>` as your SSH host when creating a new mux workspace

Note that in this approach we're multiplexing mux workspaces onto a single Coder workspace. This avoids the compute provisioning overhead to enable rapid creation and deletion of workspaces.
