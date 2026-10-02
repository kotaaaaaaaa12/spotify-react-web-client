FROM rust:1.90-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends git python3 pkg-config libssl-dev protobuf-compiler && rm -rf /var/lib/apt/lists/*
RUN git init /src/librespot
WORKDIR /src/librespot
RUN git remote add origin https://github.com/librespot-org/librespot.git && git fetch --depth 1 origin 1599145bf2c98660d35b17817b3386767a7e4b42 && git checkout --detach FETCH_HEAD
COPY container/prepare-librespot.py /tmp/prepare-librespot.py
RUN python3 /tmp/prepare-librespot.py /src/librespot
RUN cargo build --locked --release --no-default-features --features native-tls

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /src/librespot/target/release/librespot /usr/local/bin/librespot
WORKDIR /app
COPY container/player.mjs container/server.mjs container/diagnostics.mjs container/device-auth.mjs ./
USER node
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
