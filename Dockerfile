FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY . .

# Persistent data directory (mount a volume here in production)
RUN mkdir -p /app/data

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV UPDATE_ON_START=true
ENV UPDATE_INTERVAL_HOURS=24

CMD ["node", "server.js"]
