FROM debian:12-slim

ENV DISPLAY=:99

RUN apt-get update && apt-get install -y --no-install-recommends \
    freerdp2-x11 \
    xvfb \
    xauth \
    xdotool \
    openbox \
    procps \
    x11-utils \
    ca-certificates \
    tini \
    && rm -rf /var/lib/apt/lists/*

COPY entry.sh /entry.sh
RUN chmod +x /entry.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/entry.sh"]
CMD ["bash", "-c", "sleep infinity"]

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD xdpyinfo >/dev/null 2>&1 || exit 1
