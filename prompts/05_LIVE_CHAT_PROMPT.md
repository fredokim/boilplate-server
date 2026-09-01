# 5단계 — Live Experience·Realtime Chat 백엔드 프롬프트

현재 저장소는 `fredokim/boilplate-react`, 기준 브랜치는
`agent/add-interactive-examples`다. 1~4단계 서버 기반과 topology realtime이
완료된 상태에서 작업한다.

## 작업 전 확인

1. 현재 변경사항을 보존한다.
2. `src/features/live-experience`의 player model/engine, HLS 선택, live edge/DVR
   계산, chat store/controller/transport, 가상화와 scroll pin 동작을 읽는다.
3. topology realtime의 gateway, 인증, reconnect, backpressure 경계를 재사용할 수
   있는 부분과 chat에 종속적인 부분을 구분한다.
4. 프론트 mock chat transport와 demo video source를 제거하지 않는다.

## 목적과 범위

라이브 방송의 메타데이터·재생 권한·상태 API와 실시간 채팅 서버를 구현한다.
미디어 파일을 NestJS가 직접 인코딩하거나 HLS segment를 전송하지 않는다. 서버는
외부 CDN/packager가 제공하는 manifest URL과 재생 정책을 관리하는 control plane이다.

포함:

- live channel/broadcast 조회
- 재생 세션·권한 검증과 제한된 수명의 playback URL 또는 token
- broadcast 상태(`scheduled`, `live`, `ended`) 관리
- 실시간 chat 연결, history, 전송, moderation 최소 기능
- reconnect/history gap 복구

제외:

- FFmpeg transcoding·업로드 파이프라인
- DRM license server 구현
- 결제/구독
- 추천·검색
- 대규모 채팅 fan-out 인프라, Kafka/Redis 도입

## Live API

최소 다음 API를 설계한다.

- `GET /api/live/broadcasts/:broadcastId`
- `POST /api/live/broadcasts/:broadcastId/playback-session`
- 운영자용 broadcast 상태 전환 endpoint
- `GET /api/live/broadcasts/:broadcastId/chat/messages` (cursor pagination)

응답에는 프론트 `VideoSource`와 연결 가능한 source type, manifest URL, live 여부,
DVR 가능 여부, 방송 상태를 제공한다. manifest URL 자체가 secret이면 로그에 남기지
않고 짧은 TTL을 사용한다. 클라이언트가 보내는 임의 URL을 서버가 proxy/fetch하지 않는다.

상태 전환은 허용된 순서만 가능하게 하고 멱등성을 보장한다. 시간만으로 live 여부를
추측하지 말고 명시적인 상태를 authoritative source로 둔다.

## Chat 계약

- 인증된 사용자만 전송, 정책에 따라 익명 읽기는 허용 가능
- client message id를 받아 재시도 시 중복 저장을 방지
- server message id와 broadcast 단위 단조 sequence 부여
- 서버 timestamp가 정렬 기준이며 client timestamp는 신뢰하지 않음
- 메시지 길이, 전송 빈도, Unicode 정규화, 빈 문자열을 검증
- history는 cursor 기반이며 last sequence 이후 gap을 복구할 수 있음
- 삭제/차단은 tombstone event로 전달해 이미 받은 클라이언트도 수렴하게 함
- 느린 consumer는 무제한 queue 대신 명시적 disconnect/resync
- 프론트 bounded retention(300), pending cap(500), processed LRU(2000), batching과
  중복 제거를 그대로 활용한다.

## 데이터 모델

최소 Broadcast, PlaybackSession(필요한 경우), ChatMessage, ChatModerationAction 또는
동등한 모델을 설계한다.

- message 본문과 moderation 상태를 분리해 audit 가능성을 확보한다.
- hard delete 대신 사용자 화면용 삭제 상태와 보존 정책을 구분한다.
- sequence 할당과 메시지 저장은 transaction으로 처리한다.
- broadcast 종료 후 작성 가능 여부와 history 보존 기간을 문서화한다.
- 사용자 개인정보, IP, user-agent를 불필요하게 저장하지 않는다.

## 보안과 moderation

최소 `live:read`, `live:manage`, `chat:write`, `chat:moderate` permission을 사용한다.

- broadcast별 전송 rate limit
- 사용자 mute/ban과 메시지 삭제
- 운영자 동작 audit log
- URL/link 허용 정책과 출력 시 escaping 책임 명시
- WebSocket origin과 인증 검증
- 채팅 본문·playback token·Authorization/cookie를 access log에 기록하지 않음

자동 욕설 필터나 AI moderation은 정확한 정책 없이 도입하지 않는다. 확장 port만
제공하고 기본 구현은 명시적 관리 동작에 집중한다.

## 프론트 연결

- mock transport와 실제 chat transport를 환경별로 선택한다.
- HTTP history + WebSocket live event를 하나의 controller 흐름으로 연결한다.
- message optimistic send를 사용한다면 pending/sent/failed 상태와 같은 client id의
  재시도 중복 방지를 구현한다.
- HLS engine 선택과 live edge 계산은 프론트 책임으로 유지한다.
- 401 refresh 중 WebSocket 재인증과 재연결 폭주 방지를 설계한다.
- Storybook과 단위 테스트는 네트워크 없는 mock을 유지한다.

## 테스트

단위:

- broadcast 상태 전이
- playback 권한/TTL
- chat validation, rate limit, idempotency
- sequence와 tombstone 적용
- mute/ban/permission
- 민감 정보 로그 redaction

E2E/통합:

- broadcast 조회와 playback session
- live가 아닌 방송의 정책
- chat history pagination
- WebSocket send/receive와 reconnect gap 복구
- 동일 client message id 재전송 시 한 건만 저장
- 삭제 event 수신 후 클라이언트 수렴
- broadcast 종료 후 전송 거부
- slow consumer 정책

## 문서·검증

API_CONTRACT, REALTIME_INTEGRATION, live/chat 문서, Swagger/OpenAPI, Prisma migration,
환경변수와 CDN 책임 경계를 갱신한다. 프론트와 서버 전체 품질 게이트, WebSocket
통합 테스트, Prisma validate를 실제 실행한다.

## 최종 보고

최종 보고에는 control plane/media plane 경계, broadcast 상태 모델, chat delivery
semantics, idempotency/backpressure/moderation, 프론트 전환, 검증 결과, 단일 인스턴스
제한, 6단계 운영 전환 지점과 변경 파일을 포함한다.

이번 단계에서는 커밋하거나 원격 브랜치에 push하지 않는다.
