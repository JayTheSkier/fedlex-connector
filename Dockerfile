FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src/ ./src/
COPY tsconfig.json ./
RUN npx tsc
RUN npm prune --omit=dev
ENV PORT=3000
EXPOSE 3000
CMD ["node", "build/index.js"]
