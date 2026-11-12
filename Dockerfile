FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000 DB_PATH=/app/data/autoservice.db
EXPOSE 3000
CMD ["node", "server.js"]
