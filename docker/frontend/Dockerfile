FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .

ARG PROJECT_NAME=admin

# Build Angular app (adjust if needed)
RUN npx ng build ${PROJECT_NAME} --configuration production

FROM nginx:stable-alpine

ARG PROJECT_NAME=admin

# Remove old files before copying the new build so stale hashed bundles are not left behind
RUN rm -rf /usr/share/nginx/html/*

# Copy built app
COPY --from=builder /app/dist/${PROJECT_NAME}/browser /usr/share/nginx/html
COPY docker/frontend/default.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
