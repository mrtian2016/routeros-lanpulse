# lanpulse 只用 Python 标准库, 所以没有 pip install 这一步, 镜像就是 slim + 代码。
FROM python:3.12-slim
LABEL org.opencontainers.image.title="lanpulse" \
      org.opencontainers.image.description="家庭网络实时流向面板 / Real-time home network flow dashboard" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY lanpulse/ /app/lanpulse/
ENV CONFIG=/app/config.toml \
    PROM=http://prometheus:9090 \
    LISTEN_PORT=9132
EXPOSE 9132
# 健康检查用配置接口, 它不依赖 Prometheus 是否已就绪
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:9132/api/config.json',timeout=3).status==200 else 1)"
CMD ["python", "/app/lanpulse/agent.py"]
