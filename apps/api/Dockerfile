FROM node:22-alpine AS base
WORKDIR /app

# Copy workspace manifests
COPY package.json package-lock.json ./
COPY packages/db/package.json ./packages/db/
COPY apps/api/package.json ./apps/api/

# Install all deps (optional deps like imapflow will be skipped if unavailable)
RUN npm ci --ignore-optional

# Copy source
COPY packages/db ./packages/db
COPY apps/api ./apps/api

# Generate Prisma client
RUN npm run prisma:generate

# Expose port
EXPOSE 4000
ENV NODE_ENV=production

CMD ["npm", "--workspace", "@acaos/api", "run", "start"]
