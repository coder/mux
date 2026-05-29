#!/bin/sh
set -e

# The public key will be passed via environment variable or volume mount
if [ -n "$SSH_PUBLIC_KEY" ]; then
    echo "$SSH_PUBLIC_KEY" > /home/testuser/.ssh/authorized_keys
    chmod 600 /home/testuser/.ssh/authorized_keys
    chown testuser:testuser /home/testuser/.ssh/authorized_keys
fi

# Start SSH daemon in foreground
exec /usr/sbin/sshd -D -e

