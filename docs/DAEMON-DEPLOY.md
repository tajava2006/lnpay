# 어드민 데몬 배포 런북 (PLAN-DAEMON P5)

> 운영 PC(`grey`)에서 한 번에 따라 한다. **매번 헤매지 말 것.** 설계 근거는 `PLAN-DAEMON.md` §4.7·§11.
> 개발 맥에서는 아무것도 돌리지 않는다(여기 docker 결과는 운영 증거가 아니다).

## 0. 무엇이 어디에

| | 어디 | 비고 |
|---|---|---|
| 데몬 | my-server compose `lnpay-daemon` | 포트 없음. 빌드 컨텍스트 `./reference/lnpay` |
| 장부 | `my-server/lnpay-data/` (SQLite + `backups/`) | 컨테이너 uid 1000(`node`)이 쓸 수 있어야 한다 |
| 비밀 | `my-server/lnpay-secrets/` (읽기 전용 마운트) | `seed` · `app.key` · `vapid.key` · `lnpay.macaroon` |
| 유저·어드민 앱 | 클라우드 VPS nginx (정적) | 그대로. 푸시 중계·LND REST 노출은 걷어낸다(§5) |

## 1. 비밀 파일

```bash
cd ~/my-server && mkdir -p lnpay-secrets lnpay-data && chmod 700 lnpay-secrets
```

| 파일 | 만드는 법 | ⚠️ |
|---|---|---|
| `seed` | `openssl rand -hex 32 > lnpay-secrets/seed` | **종이 백업.** 프리이미지·온체인 어드민 키 전부의 뿌리(DM-005). 잃으면 진행 중 거래의 에스크로를 못 받고, 바꾸면 이미 낸 인보이스·주소를 다시 못 만든다 |
| `app.key` | APP 키 `f1f3300a…`의 nsec(또는 hex). 지금 NIP-46 번커에 있는 것을 꺼낸다 | 데몬이 부팅 때 pubkey를 대조한다 — 다르면 안 뜬다 |
| `vapid.key` | 옛 어드민 백업에서 되찾는다: `node daemon/scripts/recover-vapid.mjs <app.key> > lnpay-secrets/vapid.key` (개발 맥의 레포에서 돌려도 된다 — `pnpm install` 필요). 못 찾으면 옛 어드민 기기 localStorage `vapid-private-key` | **새로 만들면 `VAPID_PUBLIC_KEY`를 바꿔야 하고 기존 구독이 전부 무효**가 된다. 데몬은 부팅 때 공개키와 짝인지 서명으로 확인한다. 없으면 푸시 없이 돈다 |
| `lnpay.macaroon` | §2 | admin.macaroon을 쓰지 않는다 |

```bash
chmod 400 lnpay-secrets/*    # 컨테이너 uid 1000이 읽을 수 있게 소유자는 grey(1000)로
```

운영자 키(어드민 앱 로그인용)는 **새로 만든다**(§14 D2). 그 hex pubkey를 `.env`에:

```bash
echo 'LNPAY_OPERATORS=<운영자 hex pubkey>' >> .env    # 여럿이면 쉼표
```

## 2. LND

데몬은 호스트 LND의 **REST**(8080)를 `https://172.28.0.1:8080`으로 부른다(boltz·nbxplorer와 같은 게이트웨이).

**① 권한을 줄인 매크룬** — 홀드 인보이스(만들기·settle·cancel·조회), 지급·프로빙·추적, 블록 높이만:

```bash
lncli bakemacaroon invoices:read invoices:write offchain:read offchain:write info:read \
  --save_to ~/my-server/lnpay-secrets/lnpay.macaroon
```

**② REST가 컨테이너에서 닿는가** — `lnd.conf`의 `restlisten`이 `127.0.0.1:8080`뿐이면 안 닿는다.
`restlisten=0.0.0.0:8080`(방화벽으로 외부 차단) 또는 `restlisten=172.28.0.1:8080`을 **추가**한다.

**③ TLS 인증서가 그 주소를 덮는가** — 데몬은 인증서의 SAN을 확인한다:

```bash
openssl x509 -in ~/.lnd/tls.cert -noout -text | grep -A1 'Subject Alternative Name'
```

`IP Address:172.28.0.1`이 없으면 `lnd.conf`에 `tlsextraip=172.28.0.1`을 넣고 `tls.cert`/`tls.key`를 지운 뒤 LND를
재시작해 다시 만든다. ⚠️ boltz도 같은 `tls.cert`를 마운트한다 — 재생성 뒤 `docker compose restart boltz`.

**④ 확인** (컨테이너 네트워크에서):

```bash
docker run --rm --network ark-net -v ~/my-server/lnpay-secrets:/s:ro -v ~/.lnd/tls.cert:/c:ro curlimages/curl \
  --cacert /c -H "Grpc-Metadata-macaroon: $(xxd -ps -u -c 1000 ~/my-server/lnpay-secrets/lnpay.macaroon)" \
  https://172.28.0.1:8080/v1/getinfo
```

## 3. 첫 부팅

`LNPAY_EPOCH` — 데몬이 **처음 뜰 때만** 읽는 "여기부터 받는다"(unix초). 옛 프론트 어드민 시절 이벤트를 다시
처리하지 않게 **지금 시각**으로 잡고, 유저 앱 빌드의 `VITE_NOSTR_SINCE`도 같은 값으로(§9).

```bash
echo "LNPAY_EPOCH=$(date +%s)" >> .env
# 온체인을 켤 때만 (기본 꺼짐). 공개 mempool.space가 막히면 LNPAY_ONCHAIN_API로 자체 인스턴스
echo 'LNPAY_ONCHAIN_NETWORK=mainnet' >> .env

docker compose build lnpay-daemon && docker compose up -d lnpay-daemon
docker compose logs -f lnpay-daemon     # "LND … height", "릴레이", "데몬 시작"
docker inspect --format '{{.State.Health.Status}}' lnpay-daemon   # healthy = 하트비트가 2분 안
```

안 뜨면 로그 첫 줄이 이유다 — 설정·비밀이 하나라도 틀리면 **일부러** 안 뜬다(크래시 루프가 눈에 띈다).

## 4. 어드민 앱으로 확인

1. 운영자 키로 로그인 → 데몬 탭이 "정상 · N초 전"이면 상태 이벤트가 오고 있다. `ping` 왕복.
   ⚠️ **어드민 앱은 prod 빌드로 본다** — `pnpm preview:admin`(로컬 `localhost:4173`) 또는 배포본. `pnpm dev:admin`은
   `-dev` 태그라 `LNPAY_MODE=prod` 데몬과 서로 못 본다(명령은 릴레이까지 가는데 "신호 대기 중"만 뜬다, 2026-09-24).
   데몬 로그에 "다른 모드의 운영자 명령"이 찍히면 이것이다.
   오더 목록에는 **데몬이 받기 시작한 뒤(`LNPAY_EPOCH`)의 오더만** 나온다 — 옛 프론트 어드민 시절 오더는
   보이면 안 된다. 데몬 탭의 "받기 시작"이 "모름"이면 데몬이 epoch를 싣기 전 빌드다(다시 빌드).
   어드민 앱은 처음 뜰 때 옛 어드민의 브라우저 저장소를 한 번 **전부** 지운다(로그인 세션만 남긴다 — PLAN-DAEMON
   §6). ⚠️ 옛 기기 localStorage의 `vapid-private-key`도 지워지니, VAPID 키를 거기서 꺼낼 거면 새 어드민을 열기 **전에**.
2. **운영 설정** — 라이트닝 자동 승인, 보증금 비율(**§14 D5: 출시 전에 정한다** — 0%면 D4가 무의미하다),
   온체인 새 의뢰 받기(온체인을 열 때만).
3. 소액 라이트닝 드릴(mainnet): 의뢰 → 클레임 → 에스크로 결제 → 인보이스 → 계좌 → 송금 완료 → 입금 확인 →
   지급까지. 첫 실노드에서만 확인되는 것:
   - `/v2/router/track/{hash}`의 해시 인코딩(URL-safe base64) — 지급 재시도가 추적 먼저라 여기가 틀리면 매번
     "추적 실패"로 재시도한다(두 번 지급은 LND가 막는다)
   - 결제 기한이 지난 미결제 홀드 인보이스를 LND가 스스로 취소하는가(데몬 시계도 치우지만)
   - `htlcs[].expiry_height`가 채워지는가(선제 settle·조기 종결의 근거)
4. 온체인은 signet 드릴을 **dev 데몬**으로 따로 돌린다 — `ONCHAIN-SIGNET-DRILL.md`.

## 5. 옛 구조 걷어내기 (VPS)

- 웹 푸시 중계(`/push` location, 옛 `deploy/nginx-push-proxy.conf`) — 데몬이 직접 보낸다. 지운다.
- LND REST 역터널·nginx 프록시 — 어드민 브라우저가 LND를 부르던 길이다. 지운다(autossh 포워드도).
- `sites-enabled/default`가 심링크가 아니라 **사본**이다 — 편집 뒤 `nginx -t`가 사본을 봐서 속는다.

## 6. 열기

- 유저 앱 `customer/src/main.tsx`의 `MAINTENANCE = false` + `VITE_NOSTR_SINCE=<LNPAY_EPOCH>`로 빌드·배포.
- 어드민 앱 배포(리모컨).

## 7. 백업·감시

- 데몬이 하루 한 번 `lnpay-data/backups/daemon-YYYY-MM-DD.sqlite`를 뜬다(`VACUUM INTO`, 최근 7벌). 오프사이트
  루틴에 이 디렉터리를 태운다. **DB를 통째로 잃어도 돈은 시드로 되찾는다**(프리이미지·어드민 키) — 스냅숏이
  지키는 건 진행 중 거래의 장부다.
- 사람을 부르는 건 경보다(운영자 NIP-17 DM + 어드민 데몬 탭): 분쟁 진입, 몰수금 처리, 구조 대상 자금, 선제
  settle, 6번 넘게 실패하는 효과(지급·settle·브로드캐스트), 데몬이 하지 않은 settle(프리이미지 유출 의심).
- 데몬 자체가 죽으면 DM을 못 보낸다 — 어드민 앱이 "응답 없음"을 띄우고, docker healthcheck가 unhealthy가 된다.
  my-server 모니터링 자동화 항목에서 이 healthcheck를 본다.
