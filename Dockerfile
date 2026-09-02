FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

RUN corepack enable

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .
RUN pnpm build && chmod +x start.sh

ENV NODE_ENV=production

# Playwright base image may define an entrypoint that prevents our CMD from running.
ENTRYPOINT []

EXPOSE 3340

CMD ["./start.sh"]
