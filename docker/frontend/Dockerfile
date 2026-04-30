FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .

ARG PROJECT_NAME=admin

# Build Angular app (adjust if needed)
RUN npm run build -- --configuration production

FROM nginx:stable-alpine

# Copy built app
COPY --from=builder /app/dist/admin/browser /usr/share/nginx/html
COPY docker/frontend/default.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
