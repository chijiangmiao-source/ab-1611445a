FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080 \
    HOST=0.0.0.0 \
    CALIB_DB=/data/calibration.json

WORKDIR /srv

COPY app ./app
COPY tests ./tests
COPY verify.py ./verify.py

RUN python3 -m compileall -q app tests verify.py \
    && mkdir -p /data

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=10 \
  CMD python3 -c "import json,urllib.request; r=urllib.request.urlopen('http://127.0.0.1:8080/healthz',timeout=2); assert json.load(r)['status']=='ok'"

CMD ["python3", "-m", "app.server"]
