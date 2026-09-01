# 3단계 — Dashboard API·개인화 영속화 프롬프트

현재 저장소는 `fredokim/boilplate-react`, 기준 브랜치는
`agent/add-interactive-examples`다. 1단계 서버 기반과 2단계 인증 모듈이 완료된
상태에서 작업한다.

## 작업 전 확인

1. 현재 브랜치와 사용자 변경사항을 보존한다.
2. 서버의 공통 계약, auth guard/permission, Prisma schema를 읽는다.
3. 프론트의 `src/features/dashboard`, `src/features/customizable-dashboard`,
   dashboard MSW 시나리오와 DTO를 모두 확인한다.
4. `DashboardRepository`, personalization repository, versioned import/export,
   widget data source registry의 실제 인터페이스와 테스트를 계약 기준으로 삼는다.
5. 프론트의 Memory/localStorage 구현은 제거하지 않는다.

## 목적과 범위

기존 dashboard 조회 Mock API와 customizable dashboard의 로컬 영속화를 실제
NestJS API·PostgreSQL로 대체할 수 있는 서버 모듈을 만든다.

포함:

- 기존 summary/KPI/chart/table 조회 계약
- dashboard 정의 조회 및 저장
- 사용자별 preset·개인화 override CRUD
- 낙관적 동시성 제어
- 소유권·permission 검증

제외:

- 외부 BI/데이터 웨어하우스 연동
- 임의 SQL 실행
- 실시간 dashboard push
- 범용 workflow/approval engine
- 관리자용 dashboard 편집 시스템

## API

기존 프론트 계약을 우선하여 최소 다음을 구현한다.

- `GET /api/dashboard/summary`
- `GET /api/dashboard/kpi`
- `GET /api/dashboard/chart`
- `GET /api/dashboard/table`
- `GET /api/dashboards/:dashboardId`
- `GET /api/dashboards/:dashboardId/personalization`
- `PUT /api/dashboards/:dashboardId/personalization`
- preset 생성·이름 변경·선택·삭제에 필요한 명시적 endpoint

라우트 명칭이 기존 프론트 구조와 충돌한다면 호환 endpoint와 도메인 endpoint를
구분하고 이유를 문서화한다. 모든 응답은 공통 envelope를 사용한다.

## 데이터 모델과 저장 전략

- 공유 Dashboard definition과 사용자별 Personalization을 분리한다.
- 전체 dashboard 사본을 사용자마다 중복 저장하지 말고 프론트의 override 모델을
  기준으로 최소 차이를 저장한다.
- widget, layout, filter, dataSource 구조는 versioned JSON으로 저장할 수 있으나,
  서버 경계에서 DTO 검증을 수행하고 무검증 JSON을 반환하지 않는다.
- Prisma `Json`을 사용한다면 schemaVersion, 검증 함수, migration 전략을 명시한다.
- `version` 또는 `updatedAt` 기반 낙관적 잠금을 적용한다. 충돌은
  `DASHBOARD_VERSION_CONFLICT`(409)로 반환하고 최신 version을 details에 제공한다.
- userId는 body/query에서 신뢰하지 말고 인증된 사용자에서 가져온다.
- 삭제된 dashboard/preset 접근과 다른 사용자 데이터 접근을 구분하지 않아 정보가
  불필요하게 노출되지 않도록 한다.

## 권한과 오류

최소 `dashboard:read`, `dashboard:write` permission을 사용한다.

- `DASHBOARD_NOT_FOUND` — 404
- `DASHBOARD_FORBIDDEN` — 403 또는 정보 은닉을 위한 404, 결정 문서화
- `DASHBOARD_VERSION_CONFLICT` — 409
- `DASHBOARD_INVALID_SCHEMA` — 422
- `DASHBOARD_UNAVAILABLE` — 503, 기존 MSW 오류 계약과 호환

## Service 설계

- Controller는 query/body/path 파싱과 응답 DTO만 담당한다.
- DashboardService는 정의 조회, PersonalizationService는 사용자별 preset 유스케이스를
  담당한다.
- widget data endpoint는 allowlist 기반 data source registry를 사용한다. 클라이언트가
  보내는 임의 source 이름이나 SQL을 실행하지 않는다.
- 페이지·정렬·기간·필터의 최대 범위를 제한한다.
- import는 schema version과 크기 제한을 검증하고 저장 전 정규화한다.
- 저장은 transaction으로 원자성을 보장한다.

## 프론트 연결

- 기존 `DashboardRepository` 계약을 구현하는 HTTP repository를 추가한다.
- Memory/localStorage repository는 유지한다.
- 환경변수 또는 composition root에서 구현을 선택하며 기본 동작은 기존 MSW/로컬
  저장을 유지한다.
- TanStack Query key와 invalidation 정책을 기존 data source 단위에 맞춘다.
- 낙관적 UI를 사용하면 실패 시 rollback과 409 충돌 UX를 테스트한다.
- 서버 응답 DTO는 class-transformer/class-validator로 검증되는 기존 경계를 통과한다.

## 테스트

단위:

- 공유 정의 + 사용자 override 병합
- 사용자별 격리
- preset lifecycle
- schemaVersion 거부
- version 충돌
- data source allowlist와 필터 제한
- permission과 소유권

E2E:

- 기존 summary/KPI/chart/table envelope 및 DTO
- 인증 없음 401, 권한 없음 403
- personalization 저장 후 재조회
- 두 요청의 동시 update 중 하나가 409
- 잘못된 widget/import payload 검증
- 다른 사용자 preset 접근 차단

프론트 테스트:

- HTTP repository contract test
- 실제 서버 모드와 MSW 모드 선택
- 저장 실패·409 rollback

## 문서·검증

Prisma migration/seed, API_CONTRACT, Swagger, server architecture와 dashboard
영속화 전략 문서를 갱신한다. 프론트 전체 품질 게이트, 서버 전체 게이트, Prisma
validate/migration, OpenAPI 생성을 실제 실행한다.

## 최종 보고

최종 보고에는 초기 상태, 모델, endpoint, 동시성·권한 결정, 프론트 전환 방식,
테스트 결과, 제한사항, 4단계 graph/realtime 연결 지점, 변경 파일을 포함한다.

이번 단계에서는 커밋하거나 원격 브랜치에 push하지 않는다.
