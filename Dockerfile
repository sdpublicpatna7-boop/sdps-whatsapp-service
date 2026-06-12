FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Persisted Baileys auth state (mount a volume here in production).
ENV WA_AUTH_DIR=/app/auth_state
EXPOSE 3001

CMD ["node", "index.js"]
