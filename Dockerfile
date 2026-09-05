FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
ENV PORT=8787
ENV DB_PATH=/data/monkeynet.db
EXPOSE 8787
CMD ["node", "server.js"]
