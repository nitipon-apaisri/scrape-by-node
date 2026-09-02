FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

RUN corepack enable

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

ENV NODE_ENV=production

EXPOSE 3340

CMD ["xvfb-run", "--auto-servernum", "node", "dist/main.js"]
