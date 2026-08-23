# lanpulse is standard-library only, so there is no pip install step —
# the image is just python:slim plus the source.
FROM python:3.12-slim
LABEL org.opencontainers.image.title="lanpulse" \
      org.opencontainers.image.description="A live dashboard for MikroTik RouterOS" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/mrtian2016/routeros-lanpulse"
WORKDIR /app
COPY lanpulse/ /app/lanpulse/
ENV CONFIG=/app/config.toml \
    PROM=http://prometheus:9090 \
    LISTEN_PORT=9132
EXPOSE 9132
# Health check hits the config endpoint; it does not depend on Prometheus being up
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:9132/api/config.json',timeout=3).status==200 else 1)"
CMD ["python", "/app/lanpulse/agent.py"]
