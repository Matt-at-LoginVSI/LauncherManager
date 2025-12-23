FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends wget && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install required packages
RUN pip install --no-cache-dir fastapi uvicorn[standard] psycopg2-binary pydantic requests python-multipart cryptography

# Copy FastAPI source
COPY app /app

# Start FastAPI
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
