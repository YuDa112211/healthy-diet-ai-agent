FROM oven/bun:1.2.12

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./

RUN bun install --frozen-lockfile --production

COPY src ./src
COPY scripts ./scripts
COPY agent_skills ./agent_skills
COPY knowledge_base ./knowledge_base
COPY docs ./docs
COPY AGENT.md ./AGENT.md
COPY README.md ./README.md
COPY README_zh.md ./README_zh.md
COPY README_jp.md ./README_jp.md
COPY CHANGELOG_CODEX.md ./CHANGELOG_CODEX.md

RUN mkdir -p users_images knowledge_base/uploads knowledge_base/ingested_markdown data

ENV NODE_ENV=production
ENV PORT=8001
ENV STORAGE_BACKEND=sqlite
ENV SQLITE_DB_PATH=/app/data/healthy-diet-agent.db

EXPOSE 8001

VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || '8001') + '/ping').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "start"]
