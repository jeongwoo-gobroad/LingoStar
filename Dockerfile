FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public
COPY privacy-poilcy.html terms-of-service.html ./

EXPOSE 8080
CMD ["node", "server.js"]
