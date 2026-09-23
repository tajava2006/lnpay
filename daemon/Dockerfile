# 페어바이 어드민 데몬 (docs/PLAN-DAEMON.md §11)
#
# 빌드 컨텍스트는 **레포 루트**다 — shared를 번들에 넣어야 한다.
#   docker build -f daemon/Dockerfile .
#
# 결과 이미지에는 번들 한 파일만 들어간다(node_modules 없음). `node:sqlite`는 Node 내장이라
# 네이티브 빌드도 없다.

FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
# 워크스페이스 매니페스트는 전부 넣는다 — 락파일의 importer와 어긋나면 --frozen-lockfile이 거부한다
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json shared/
COPY customer/package.json customer/
COPY sponsor/package.json sponsor/
COPY admin/package.json admin/
COPY daemon/package.json daemon/
RUN pnpm install --frozen-lockfile --filter @sajwo-tracker/daemon...
COPY shared/src shared/src
COPY daemon/build.mjs daemon/tsconfig.json daemon/
COPY daemon/src daemon/src
RUN pnpm --filter @sajwo-tracker/daemon build

FROM node:24-slim
WORKDIR /app
COPY --from=build /repo/daemon/dist/ ./dist/
ENV NODE_ENV=production \
    LNPAY_DATA_DIR=/app/data
# 데이터 볼륨은 이 사용자(uid 1000)가 쓸 수 있어야 한다
USER node
# 틱마다 쓰는 하트비트가 2분 넘게 안 바뀌면 죽은 것으로 본다
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "const t=Number(require('fs').readFileSync(process.env.LNPAY_DATA_DIR+'/heartbeat','utf8'));process.exit(Date.now()-t<120000?0:1)"
CMD ["node", "--enable-source-maps", "dist/daemon.mjs"]
