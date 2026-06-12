FROM node:20-slim
 
# git is required by @whiskeysockets/baileys which resolves a git dependency at install time.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
 
WORKDIR /app
 
COPY package.json ./
RUN npm install --omit=dev
 
COPY . .
 
# Persisted Baileys auth state (mount a volume here in production).
ENV WA_AUTH_DIR=/app/auth_state
EXPOSE 3001
 
CMD ["node", "index.js"]
