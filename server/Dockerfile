FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

# Needed because start:server uses ts-node and typescript at runtime
RUN npm install --legacy-peer-deps --include=dev

COPY . .

EXPOSE 3001

CMD ["npx", "ts-node", "--project", "server/tsconfig.json", "server/index.ts"]
