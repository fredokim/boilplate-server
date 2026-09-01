# 6단계 — 실서버 전환·운영 품질 고도화 프롬프트

현재 저장소는 `fredokim/boilplate-react`, 기준 브랜치는
`agent/add-interactive-examples`다. 1~5단계에서 server foundation, auth,
dashboard, graph/topology realtime, live/chat 모듈이 구현된 상태를 전제로 한다.

## 작업 전 확인과 원칙

1. 브랜치와 작업 트리를 확인하고 사용자 변경을 보존한다.
2. 모든 아키텍처/API/realtime 문서, CI, 환경변수, Docker, Prisma migration,
   프론트 composition root와 MSW 선택 로직을 읽는다.
3. 현재 검증 결과를 먼저 기록해 baseline을 만든다.
4. 이번 단계는 기능 추가가 아니라 안전한 실제 서버 전환과 운영 가능성 검증이다.
5. Redis/Kafka/Kubernetes 같은 기술을 필요성 없이 추가하지 않는다.

## 목표

- 프론트의 Mock API/local persistence/mock realtime과 실제 서버 구현을 명시적인
  환경 설정으로 전환 가능하게 한다.
- production build에서는 실수로 MSW가 활성화되지 않게 한다.
- CI에서 프론트·서버·계약·DB migration을 함께 검증한다.
- 보안, 관측성, 장애 대응, 배포·rollback 문서를 갖춘다.

## 프론트 통합

- `mock`, `server` data mode를 하나의 검증된 환경 설정에서 결정한다.
- production에서 mock mode를 선택하면 build 또는 시작 단계에서 실패하게 한다.
- Axios base URL, credentials, timeout, refresh single-flight, requestId 전파를 정리한다.
- auth, dashboard, graph snapshot, topology WebSocket, live/chat을 실제 adapter에 연결한다.
- Memory/localStorage/mock transport는 Storybook·테스트·offline demo 용도로 유지한다.
- transport/repository 선택이 feature 컴포넌트 내부에 흩어지지 않게 composition root에서
  수행한다.
- 서버 DTO와 프론트 DTO의 계약 차이를 수정하고, 응답 `error.details`를 프론트가
  안전하게 사용할 수 있게 한다.

## 계약 자동 검증

- 서버 OpenAPI JSON을 재현 가능하게 생성한다.
- CI에서 OpenAPI 생성 결과의 drift를 검출한다.
- 프론트 타입 생성 여부를 검토하되, 기존 class-transformer/class-validator DTO 검증을
  무조건 제거하지 않는다. compile-time 타입과 runtime 검증의 역할을 문서화한다.
- 핵심 endpoint는 consumer contract test로 MSW fixture와 실제 서버 응답의 형태가
  동일한지 증명한다.
- WebSocket event schema도 version과 runtime validation을 갖는다.

## 보안 점검

- CORS allowlist, cookie, CSRF 위협 모델, Helmet/security headers
- access/refresh token 만료·회전·폐기
- body/message 크기 제한과 rate limiting
- Prisma query/입력 allowlist, mass assignment 방지
- 로그 redaction과 production 오류 비노출
- Swagger 운영 비활성 또는 보호
- dependency audit 정책: production dependency는 차단하고, dev-only 미해결 항목은
  근거·만료일·담당을 가진 예외로만 허용
- secret은 저장소·Docker image·클라이언트 bundle에 포함하지 않음

실제 침투 테스트 서비스나 WAF를 구현했다고 주장하지 않는다. 코드와 자동 테스트로
검증한 범위를 구분한다.

## 관측성

기존 logger port를 유지하면서 다음 경계를 추가한다.

- request latency, error rate, DB readiness
- WebSocket active connection, reconnect, replay, resync, drop
- auth login failure/refresh reuse 탐지
- chat send/reject/rate-limit
- trace context와 requestId 상호 연결

OpenTelemetry를 적용한다면 exporter가 없어도 동작하는 표준 SDK 경계까지만 구성하고,
vendor에 직접 결합하지 않는다. high-cardinality 사용자 ID나 메시지 본문을 metric label로
사용하지 않는다.

## 장애·종료·배포

- SIGTERM 시 신규 요청 차단, HTTP drain, WebSocket 종료 안내, Prisma disconnect 순서
- readiness는 drain 시작 즉시 실패하고 liveness는 종료 직전까지 유지
- migration은 app startup과 분리한 배포 명령으로 실행
- backward-compatible expand/migrate/contract 원칙 문서화
- seed는 production에서 실행되지 않게 보호
- Dockerfile은 multi-stage, non-root, production dependency만 포함하고 healthcheck 제공
- 로컬 compose에는 app + PostgreSQL을 선택적으로 실행할 profile 제공
- 배포 플랫폼을 특정하지 않는 환경변수·포트·health 계약 제공

## CI 품질 게이트

기존 프론트 gate의 의미를 바꾸지 않고 전체 gate를 추가한다.

- frontend lint/typecheck/unit/build/bundle/dependency checks
- server lint/typecheck/build/unit/e2e
- Prisma format/validate/generate 및 migration drift 검사
- OpenAPI drift와 contract tests
- production Docker image build 및 컨테이너 smoke test
- 가능하면 PostgreSQL service container를 사용한 최소 통합 테스트

WodPlanner는 이 저장소 작업 범위가 아니며 CI나 문서에 끌어들이지 않는다.

## 성능·복원력 검증

과도한 목표 수치를 임의로 만들지 말고 측정 가능한 baseline을 작성한다.

- health와 주요 read endpoint의 부하 smoke test
- dashboard pagination/response 크기
- graph snapshot 크기와 event replay 구간
- chat message burst와 slow consumer
- DB connection pool과 graceful degradation

부하 도구 스크립트는 안전한 로컬 기본값을 사용하고 운영 URL을 실수로 대상으로 삼지
못하게 보호한다. 결과는 환경·데이터 크기·동시성 조건과 함께 기록한다.

## 테스트 시나리오

- mock mode와 server mode의 핵심 사용자 흐름
- login → dashboard 저장 → graph 조회/실시간 변경 → live/chat
- access 만료 중 동시 요청의 refresh 1회 처리
- DB 중단 시 live 성공/ready 실패 및 복구
- WebSocket 중단 후 replay/resync
- SIGTERM drain
- migration 적용 전후 호환성
- production build에서 MSW 비활성
- 민감 데이터가 응답·로그·bundle에 없는지

## 문서

- 루트 README quick start 및 mode 선택
- 배포·migration·rollback runbook
- 장애 대응 runbook
- 환경변수 표와 secret 관리 원칙
- API/Realtime 계약과 호환성 정책
- 관측성 지표·알람 후보
- 알려진 단일 인스턴스 제한과 Redis 등 확장 시점의 판단 기준

## 최종 보고

1. 초기 상태와 baseline
2. 실제 서버 전환 구조
3. 계약 자동 검증
4. 보안·관측성·종료 처리
5. CI와 배포 산출물
6. 전체 테스트 및 측정 결과
7. 미해결 위험과 운영 전 확인사항
8. mock과 server 모드 사용법
9. 변경 파일 목록

검증 실패나 이 환경에서 실행할 수 없는 Docker/DB 검증은 숨기지 말고 정확한 원인과
재현 명령을 보고한다. 이번 단계에서는 커밋하거나 원격 브랜치에 push하지 않는다.

