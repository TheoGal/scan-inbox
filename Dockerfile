FROM python:3.13-alpine

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DB_PATH=/data/scans.db \
    PORT=8000

WORKDIR /app
COPY server.py .
# Built-in pages; a mounted ./static folder can override individual files (see server.py).
COPY static ./static-default

# Unprivileged user; /data is created here so a fresh named volume inherits its ownership.
RUN adduser -D -u 10001 app && mkdir /data && chown app:app /data
USER app
VOLUME /data
EXPOSE 8000


CMD ["python", "server.py"]
