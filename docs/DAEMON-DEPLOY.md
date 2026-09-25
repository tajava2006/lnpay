# 운영 런북 — 데몬 배포 · 앱 배포 · 감시

운영 PC(`grey`)와 클라우드 VPS에서 따라 한다. **매번 헤매지 말 것.** 구조는 [ARCHITECTURE.md](ARCHITECTURE.md).
개발 맥에서는 아무것도 돌리지 않는다(거기 docker 결과는 운영 증거가 아니다).

## 0. 무엇이 어디에

| | 어디 | 비고 |
|---|---|---|
| 데몬 | 운영 PC, my-server compose `lnpay-daemon` | 포트 없음. 빌드 컨텍스트 `./reference/lnpay` |
| 장부 | `my-server/lnpay-data/` (SQLite + `backups/` + `heartbeat`) | 컨테이너 uid 1000(`node`)이 쓸 수 있어야 한다 |
| 비밀 | `my-server/lnpay-secrets/` (읽기 전용 마운트) | `seed` · `app.key` · `vapid.key` · `lnpay.macaroon` |
| 데몬 설정 | `my-server/.env` | `LNPAY_OPERATORS`, `LNPAY_EPOCH`, `LNPAY_ONCHAIN_NETWORK`, `LNPAY_LND_URL` … (`daemon/src/config.ts`) |
| 유저·어드민 앱 | VPS의 lnpay 클론, nginx 정적 서빙 | `pnpm ship`으로 빌드. 앱 빌드 설정은 lnpay 레포 루트 `.env` |
| signet 드릴 데몬 | compose `lnpay-daemon-signet` (profile `signet`) | 장부 `lnpay-data-signet/`. 평소엔 안 뜬다 — [ONCHAIN-SIGNET-DRILL.md](ONCHAIN-SIGNET-DRILL.md) |

## 1. 비밀 파일 (처음 한 번)

```bash
cd ~/my-server && mkdir -p lnpay-secrets lnpay-data && chmod 700 lnpay-secrets
```

| 파일 | 만드는 법 | ⚠️ |
|---|---|---|
| `seed` | `openssl rand -hex 32 > lnpay-secrets/seed` | **종이 백업.** 프리이미지·온체인 어드민 키 전부의 뿌리(DM-005). 잃으면 진행 중 거래의 에스크로를 못 받고, 바꾸면 이미 낸 인보이스·주소를 다시 못 만든다 |
| `app.key` | APP 키 `f1f3300a…`의 nsec(또는 hex) | 데몬이 부팅 때 pubkey를 대조한다 — 다르면 안 뜬다. **바꾸면 유저 앱 전체가 끊긴다** |
| `vapid.key` | 기존 키를 쓴다. 잃었으면 옛 어드민 백업에서: `node daemon/scripts/recover-vapid.mjs <app.key> > lnpay-secrets/vapid.key` | 새로 만들면(`scripts/gen-vapid.mjs`) `VAPID_PUBLIC_KEY`를 바꿔야 하고 **기존 구독이 전부 무효**. 데몬이 부팅 때 공개키와 짝인지 확인한다. 없으면 푸시 없이 돈다 |
| `lnpay.macaroon` | §2 | admin.macaroon을 쓰지 않는다 |

```bash
chmod 400 lnpay-secrets/*    # 소유자는 grey(1000) — 컨테이너 uid 1000이 읽는다
echo 'LNPAY_OPERATORS=<운영자 hex pubkey>' >> .env    # 어드민 앱 로그인 키. 여럿이면 쉼표. APP 키는 거부된다
```

## 2. LND (처음 한 번)

데몬은 호스트 LND의 **REST**를 docker 게이트웨이(`172.28.0.1`)로 부른다(boltz·nbxplorer와 같은 방식).
주소는 `.env`의 `LNPAY_LND_URL`.

**① 권한을 줄인 매크룬** — 홀드 인보이스(만들기·settle·cancel·조회), 지급·프로빙·추적, 블록 높이만:

```bash
lncli bakemacaroon invoices:read invoices:write offchain:read offchain:write info:read \
  --save_to ~/my-server/lnpay-secrets/lnpay.macaroon
```

**② REST가 컨테이너에서 닿는가** — `lnd.conf`의 `restlisten`에 게이트웨이 주소가 있어야 한다
(`restlisten=172.28.0.1:<포트>` 추가, 또는 `0.0.0.0` + 방화벽).

**③ TLS 인증서가 그 주소를 덮는가** — 데몬은 인증서의 SAN을 확인한다:

```bash
openssl x509 -in ~/.lnd/tls.cert -noout -text | grep -A1 'Subject Alternative Name'
```

`IP Address:172.28.0.1`이 없으면 `lnd.conf`에 `tlsextraip=172.28.0.1`을 넣고 `tls.cert`/`tls.key`를 지운 뒤 LND를
재시작해 다시 만든다. ⚠️ boltz도 같은 `tls.cert`를 마운트한다 — 재생성 뒤 `docker compose restart boltz`.

**④ 확인** (컨테이너 네트워크에서, 포트는 `LNPAY_LND_URL`과 같게):

```bash
docker run --rm --network ark-net -v ~/my-server/lnpay-secrets:/s:ro -v ~/.lnd/tls.cert:/c:ro curlimages/curl \
  --cacert /c -H "Grpc-Metadata-macaroon: $(xxd -ps -u -c 1000 ~/my-server/lnpay-secrets/lnpay.macaroon)" \
  https://172.28.0.1:<포트>/v1/getinfo
```

## 3. 데몬 부팅 · 업데이트

**첫 부팅(새 장부)만** `LNPAY_EPOCH`를 정한다 — 데몬이 "여기부터 받는다"로 DB에 박는 unix초다. 그 뒤로는 `.env`를
바꿔도 안 움직인다. 그 전의 이벤트(옛 장부·옛 구조 시절)는 데몬도 어드민 앱도 보지 않는다.

```bash
echo "LNPAY_EPOCH=$(date +%s)" >> .env                # 새 장부일 때만
echo 'LNPAY_ONCHAIN_NETWORK=mainnet' >> .env           # 온체인을 켤 때만. 자체 인스턴스면 LNPAY_ONCHAIN_API도
```

**코드를 바꾸면 이미지를 다시 빌드한다** — `up -d`만으로는 옛 이미지로 재시작한다(옛 이미지로 돌면 마감·문구가 어긋난다.
어드민 데몬 탭이 창 길이 불일치를 경고한다).

```bash
git -C reference/lnpay pull
docker compose build lnpay-daemon && docker compose up -d lnpay-daemon
docker compose logs -f lnpay-daemon     # "LND … height", "릴레이", "데몬 시작"
docker inspect --format '{{.State.Health.Status}}' lnpay-daemon   # healthy = 하트비트가 2분 안
```

안 뜨면 로그 첫 줄이 이유다 — 설정·비밀이 하나라도 틀리면 **일부러** 안 뜬다. 흔한 것:

| 로그 | 뜻 |
|---|---|
| `다른 데이터 디렉터리` / `LNPAY_MODE=…` | 장부 하나 = 모드 하나. 다른 모드로 띄우려면 다른 장부(`guards.ts`) |
| `진행 중 온체인 오더 N건이 <네트워크>` · `온체인을 껐는데` | 진행 중 오더가 끝나기 전엔 네트워크를 바꾸거나 끌 수 없다 |
| `APP 키가 기대한 pubkey가 아니다` | `app.key`가 `LNPAY_APP_PUBKEY`(기본 `f1f3300a…`)의 짝이 아니다 |
| `VAPID 개인키가 공개키의 짝이 아니다` | `vapid.key`가 앱에 박힌 `VAPID_PUBLIC_KEY`의 짝이 아니다 |

## 4. 어드민 앱으로 확인 · 설정

1. 운영자 키로 로그인 → 데몬 탭이 "정상 · N초 전"이면 상태가 오고 있다. `ping` 왕복.
   ⚠️ **어드민 앱은 prod 빌드로 본다** — 배포본 또는 `pnpm preview:admin`(`localhost:4173`). `pnpm dev:admin`은 `-dev`
   태그라 prod 데몬과 서로 못 본다(데몬 로그에 "다른 모드의 운영자 명령"). 데몬 탭의 "받기 시작"이 epoch다.
2. **운영 설정**: 라이트닝 자동 승인, 보증금 비율(고객·후원자, 0이면 끔 — RISKS R-5), 온체인 새 의뢰 받기.
3. 경보가 뜨면 데몬 탭 최상단에 있고 운영자에게 NIP-17 DM으로도 간다. 처리했으면 확인(ack).

## 5. 유저·어드민 앱 배포 (VPS)

```bash
# VPS의 lnpay 클론에서
git branch --show-current   # master
pnpm ship    # pull → 설치 → 타입체크·테스트 → 유저스크립트·유저 앱·리다이렉트·어드민 빌드
```

- 빌드 설정은 lnpay 레포 **루트** `.env`(vite `envDir: '..'`). `VITE_NOSTR_SINCE=<unix초>` — 그 전 이벤트를 유저 앱이
  구독하지 않는다. 데몬 epoch 이상으로 둔다(epoch보다 이르면 옛 구조 시절 오더가 보인다).
- 빌드 때 박히는 값이라 `.env`를 바꾸면 `ship`을 다시 돌린다.
- **공사 중 스위치**는 `.env`가 아니라 코드다 — `customer/src/main.tsx`의 `MAINTENANCE`. 바꾸려면 커밋 → 푸시 → `ship`.

## 6. 로컬에서 실결제로 확인할 때

- `pnpm preview:customer` → `localhost:4174` (prod 빌드를 `--mode localopen`으로 — 공사 중이어도 로컬은 열린다).
  그래도 공사 중 화면이면 4174를 쥔 옛 preview 서버를 의심한다(`ss -ltnp | grep 4174`). 로컬의 공사 중 화면은 빌드
  커밋을 보여준다.
- 포트는 고정(4173 어드민 / 4174 유저, `strictPort`) — 오리진이 바뀌면 localStorage의 키가 달라져 다른 사람이 된다.
- 고객·후원자는 **다른 키**여야 한다 → 브라우저 프로필 2개(시크릿 창은 닫으면 키가 날아간다).
- ⚠️ **결제는 데몬 LND 밖의 지갑으로.** 같은 LND가 자기 인보이스를 결제하면 셀프 결제라 거부한다. 브리지(boltz 경유)가
  이 LND로 내는 결제가 그 경우다(boltz는 `allowSelfPayment`를 켜지 않는다).
- 온체인은 signet 드릴 데몬으로 따로 — [ONCHAIN-SIGNET-DRILL.md](ONCHAIN-SIGNET-DRILL.md).

## 7. 백업 · 감시

- 데몬이 하루 한 번 `lnpay-data/backups/daemon-YYYY-MM-DD.sqlite`를 뜬다(최근 7벌). 오프사이트 루틴에 이 디렉터리를
  태운다. **DB를 통째로 잃어도 돈은 시드로 되찾는다** — 스냅숏이 지키는 건 진행 중 거래의 장부다.
- 사람을 부르는 경보(운영자 DM + 데몬 탭): 분쟁 진입, 몰수금 처리, 약정 밖 자금(구조), 선제 settle, 오래 실패하는 효과
  (지급·settle·브로드캐스트), 장부에 없는 에스크로 소모(키 유출 의심), 데몬이 하지 않은 settle.
- ⚠️ **데몬이 죽으면 DM도 못 보낸다.** 지금 외부 감시는 없다 — docker healthcheck(로컬)와 어드민 앱의 하트비트 표시뿐이다.
  라이트닝 `remitted` 거래는 데몬이 약 이틀 넘게 꺼지면 후원자가 잃을 수 있다(RISKS R-3). 하트비트 파일
  (`lnpay-data/heartbeat`)을 보는 외부 알림을 붙이는 게 다음 일이다.

## 8. 옛 구조 걷어내기 (VPS, 한 번)

프론트 어드민 시절의 길이다. 데몬 전환 뒤로 쓰지 않는다.

- 웹 푸시 중계(`/push` location) — 데몬이 푸시를 직접 보낸다.
- LND REST nginx 프록시 — 어드민 브라우저가 LND를 부르던 길. 역터널은 다른 서비스가 같이 쓰면 두고 LND REST 포워드만.
- `sites-enabled/default`가 심링크가 아니라 **사본**이다 — nginx가 실제로 읽는 파일을 고치고 `nginx -t && systemctl reload nginx`.
- lnpay 루트 `.env`의 `VITE_PUSH_PROXY`는 더 이상 읽는 코드가 없다.
