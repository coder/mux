FROM alpine:latest

# Install OpenSSH server, git, and bash
# bash is required for remote command execution (mux forces bash to avoid shell compatibility issues)
RUN apk add --no-cache openssh-server git bash

# Create test user
RUN adduser -D -s /bin/sh testuser && \
    echo "testuser:testuser" | chpasswd

# Create .ssh directory for authorized_keys
RUN mkdir -p /home/testuser/.ssh && \
    chmod 700 /home/testuser/.ssh && \
    chown testuser:testuser /home/testuser/.ssh

# Create working directory
RUN mkdir -p /home/testuser/workspace && \
    chown testuser:testuser /home/testuser/workspace

# Setup SSH host keys
RUN ssh-keygen -A

# Copy SSH config
COPY sshd_config /etc/ssh/sshd_config

# Expose SSH port
EXPOSE 22

# Copy and set entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

