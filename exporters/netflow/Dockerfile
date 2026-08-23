FROM python:3.12-slim
WORKDIR /app
COPY collector.py /app/
EXPOSE 9133 2055/udp
CMD ["python", "/app/collector.py"]
