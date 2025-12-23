FROM rundeck/rundeck:5.15.0

USER root

# -------------------------------------------------------------
# Install tools + docker CLI
# -------------------------------------------------------------
RUN apt-get update && apt-get install -y \
    openssh-client \
    sshpass \
    jq \
    unzip \
    curl \
    docker-cli \
    && rm -rf /var/lib/apt/lists/*

# -------------------------------------------------------------
# Install Docker Compose v2 (persistent CLI plugin)
# -------------------------------------------------------------
RUN mkdir -p /usr/lib/docker/cli-plugins \
    && curl -SL https://github.com/docker/compose/releases/download/v2.29.2/docker-compose-linux-x86_64 \
        -o /usr/lib/docker/cli-plugins/docker-compose \
    && chmod +x /usr/lib/docker/cli-plugins/docker-compose

# -------------------------------------------------------------
# Match host docker group (GID 996 in your case)
# and give rundeck access to docker.sock
# -------------------------------------------------------------
RUN groupadd -g 996 docker || true \
    && usermod -aG docker rundeck

USER rundeck
