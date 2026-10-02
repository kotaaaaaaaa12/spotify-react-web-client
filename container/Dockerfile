FROM rust:1.90-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends git pkg-config libssl-dev protobuf-compiler && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch v0.8.0 https://github.com/librespot-org/librespot.git /src/librespot
WORKDIR /src/librespot
RUN cargo build --locked --release --no-default-features --features native-tls

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /src/librespot/target/release/librespot /usr/local/bin/librespot
WORKDIR /app
COPY container/player.mjs container/server.mjs container/diagnostics.mjs ./
USER node
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
