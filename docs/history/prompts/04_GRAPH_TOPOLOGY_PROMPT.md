# 4단계 — Visual Graph CRUD·Realtime Topology 프롬프트

현재 저장소는 `fredokim/boilplate-react`, 기준 브랜치는
`agent/add-interactive-examples`다. 서버 기반, auth, dashboard 단계가 완료된
상태에서 작업한다.

## 작업 전 확인

1. 변경사항과 브랜치를 확인하고 사용자 작업을 보존한다.
2. `VISUAL_GRAPH.md`, `REALTIME_INTEGRATION.md`와
   `src/features/visual-graph` 전체를 먼저 읽는다.
3. 특히 runtime event의 `sequence`, `eventId`, entity key, snapshot/resync,
   enqueue/flush batching 계약과 transport 인터페이스를 정확히 파악한다.
4. 서버 공통 envelope, auth permission, 로깅, Prisma lifecycle을 재사용한다.
5. 프론트 mock transport와 graph fixture를 제거하지 않는다.

## 목적

그래프 정의를 PostgreSQL에 저장하고, 초기 snapshot은 HTTP로 제공하며, 변경 이벤트는
WebSocket으로 전달하는 실제 topology backend를 구축한다. 프론트의 framework-agnostic
runtime store/controller는 유지하고 transport/source만 교체 가능하게 한다.

## HTTP API

최소 다음 유스케이스를 제공한다.

- graph 목록·상세 조회
- graph 생성·수정·삭제
- node/edge 일괄 저장 또는 명시적 mutation
- `GET /api/graphs/:graphId/topology/snapshot`
- snapshot 이후 누락 이벤트를 복구할 수 있는 resync endpoint

그래프 편집 API와 runtime 상태 API를 구분한다. 모든 mutation은 optimistic version을
받고 충돌을 409로 반환한다. node/edge 개수와 payload 크기에 상한을 둔다.

## Prisma 모델

최소 Graph, GraphNode, GraphEdge, TopologyEvent 또는 동등한 모델을 설계한다.

- node/edge ID uniqueness와 graph 소속을 DB constraint로 보장한다.
- 자기 참조 edge, dangling edge, 중복 edge 정책을 명시하고 검증한다.
- graph의 구조 version과 realtime sequence는 역할이 다르므로 분리한다.
- event sequence는 graph 또는 stream 단위로 단조 증가해야 한다.
- sequence 할당과 event 저장, 현재 상태 변경은 하나의 transaction으로 처리한다.
- 이벤트 보존 기간과 pruning 경계를 둔다. Kafka/event sourcing은 도입하지 않는다.

## WebSocket 계약

Nest WebSocket gateway를 독립 `realtime` 또는 topology 하위 모듈로 구현한다.

- 인증 handshake와 graph별 subscription 권한 확인
- subscribe 시 client의 마지막 sequence를 받음
- 연속 구간이면 누락 이벤트 replay, 보존 범위를 벗어나면 snapshot resync 지시
- event payload에 `eventId`, `sequence`, `entity`, `kind`, 발생 시각 포함
- heartbeat, disconnect reason, reconnect 친화적 오류 코드
- 한 연결의 subscription 수, 메시지 크기, 전송 빈도 제한
- 느린 consumer의 무제한 queue를 허용하지 않고 disconnect/resync 정책 적용
- 프로세스 메모리 fan-out adapter를 먼저 사용하되 향후 Redis adapter 교체 지점을 둔다.
  이번 단계에서는 Redis를 설치하지 않는다.

exactly-once를 주장하지 않는다. 서버는 재전송 가능하고 클라이언트의 eventId dedup과
sequence 검증을 함께 사용해 at-least-once 환경에서 수렴하도록 설계한다.

## 프론트 연결

- 기존 mock transport와 실제 WebSocket transport를 설정으로 선택한다.
- snapshot HTTP source와 WebSocket event source를 controller에 연결한다.
- 기존 enqueue/flush, coalescing, pending cap, hidden-tab batching, backoff/jitter,
  generation guard를 훼손하지 않는다.
- 연결 중단, sequence gap, duplicate, stale event, resync 중 재연결을 테스트한다.
- 기본 개발·Storybook·단위 테스트는 mock transport를 유지한다.

## 권한·오류·관측성

최소 `graph:read`, `graph:write`, `topology:subscribe` permission을 둔다.
HTTP 오류는 `GRAPH_NOT_FOUND`, `GRAPH_VERSION_CONFLICT`, `GRAPH_INVALID_EDGE`,
`TOPOLOGY_RESYNC_REQUIRED` 등 안정적인 도메인 코드로 표현한다.

로그/지표 경계에는 graphId, connectionId, requestId, lastSequence, replay count,
resync count, dropped/disconnected slow consumer를 기록하되 token과 전체 payload는
기록하지 않는다. 높은 빈도의 event마다 info log를 남기지 않는다.

## 테스트

단위:

- graph invariant와 optimistic conflict
- transaction 내 sequence 할당
- replay 가능/불가능 판단
- subscription permission
- slow consumer/backpressure 정책
- event serializer와 프론트 타입 호환

E2E/통합:

- graph CRUD와 invalid edge
- snapshot envelope
- WebSocket 인증 실패·정상 subscribe
- disconnect 후 lastSequence로 replay
- retention 밖 sequence에서 resync
- duplicate delivery에도 최종 client snapshot 동일
- 두 mutation의 sequence가 중복되지 않음

실제 DB가 필요한 동시성 테스트는 Docker 기반 별도 통합 명령으로 명확히 분리하고,
기본 단위/E2E는 교체 가능한 port로 안정적으로 실행되게 한다.

## 문서·검증

VISUAL_GRAPH, REALTIME_INTEGRATION, API_CONTRACT, Swagger/OpenAPI, Prisma migration,
운영 시 WebSocket origin과 scaling 제약을 갱신한다. 프론트·서버 전체 품질 게이트와
realtime 전용 테스트를 실행한다.

## 최종 보고

최종 보고에는 HTTP/WS 계약, sequence 일관성, replay/resync, backpressure, 권한,
프론트 transport 선택, 검증 결과, 단일 인스턴스 제한, 5단계 live/chat 재사용 지점과
변경 파일을 포함한다.

이번 단계에서는 커밋하거나 원격 브랜치에 push하지 않는다.
