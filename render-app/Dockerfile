FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=10000 DATA_DIR=/var/data
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
RUN mkdir -p /var/data/uploads /var/data/outputs && chown -R node:node /app /var/data
USER node
EXPOSE 10000
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","server.js"]