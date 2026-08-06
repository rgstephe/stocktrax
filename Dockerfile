FROM node:20-bookworm-slim

# better-sqlite3 ships prebuilt binaries for most platforms, but include build
# tools so it compiles cleanly if a prebuilt isn't available for your arch.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Persisted SQLite database lives here (mount a volume in compose).
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "src/server.js"]
