FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates pulseaudio pulseaudio-utils libpipewire-0.3-0t64 libatomic1 tar && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY container/*.mjs ./
RUN node install-soloist.mjs /opt/soloist && chmod 755 /opt/soloist /opt/soloist/soloist
USER node
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
