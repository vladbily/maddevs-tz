FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG PUBLIC_URL=http://localhost:8080
ENV VITE_PUBLIC_URL=$PUBLIC_URL
RUN npm run format:check && npm run build

FROM nginx:1.28-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY api-proxy.conf /etc/nginx/api-proxy.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80 8081
