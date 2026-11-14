FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY knowledge.py get_products_batch.py candidate_discovery.py embedding_index.py monetary_send_guard.py server.py reviewed_field_aliases.py reviewed_field_aliases.json ./
COPY launch.py snapshot.json ./
RUN useradd --system --uid 10001 app && chown -R app /app
USER app
CMD ["python", "launch.py"]
