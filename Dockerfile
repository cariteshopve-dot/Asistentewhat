FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production
# La base de datos vive en /app/datos: monta ahí un volumen para no perderla
VOLUME /app/datos
EXPOSE 3000
CMD ["node", "src/server.ts"]
