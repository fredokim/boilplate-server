# 2단계 — 인증·인가 모듈 구현 프롬프트

현재 저장소는 `fredokim/boilplate-react`이며 작업 기준은
`agent/add-interactive-examples` 브랜치다.

1단계에서 `server/` 아래에 NestJS + PostgreSQL + Prisma 기반 서버 기반이
구축되어 있다. 공통 API envelope, 전역 검증, 예외 필터, requestId, 구조화
로그, health API, Swagger가 이미 존재한다. 이번 작업은 이 기반 위에 실제
인증과 인가 모듈을 추가하는 것이다.

## 작업 전 확인

1. 현재 브랜치와 변경사항을 확인하고 사용자 변경을 보존한다.
2. 루트 문서와 `server/README.md`, `server/ARCHITECTURE.md`, Prisma schema,
   공통 예외·검증·로깅 구현을 먼저 읽는다.
3. 프론트의 `src/features/auth`, `src/stores/auth.store.ts`,
   `src/core/auth/tokenStorage.ts`, MSW auth 시나리오와 DTO를 확인한다.
4. 특히 프론트가 `AUTH_REQUIRED`를 인증 실패로 분류한다는 계약을 보존한다.
5. 1단계 공통 계층을 복제하지 말고 재사용한다.

## 이번 단계의 범위

- 이메일/비밀번호 로그인
- 현재 세션 조회
- access token 재발급
- 로그아웃 및 refresh session 폐기
- 역할·권한 기반 guard의 최소 기반
- 사용자와 refresh session Prisma 모델 및 seed 계정

회원가입, 이메일 인증, 비밀번호 재설정, OAuth/소셜 로그인, MFA, 조직·테넌트,
관리자 사용자 CRUD는 구현하지 않는다.

## API 계약

최소 다음 엔드포인트를 제공한다.

- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `GET /api/auth/session`

프론트의 기존 login/session DTO와 정확히 호환한다. 불일치가 있으면 서버
계약을 우선 프론트 계약에 맞추고, 필요한 최소 변경만 프론트 DTO에 반영한다.
모든 응답은 기존 공통 envelope를 사용한다.

오류 코드는 최소 다음을 구분한다.

- `AUTH_INVALID_CREDENTIALS` — 잘못된 자격 증명, 401
- `AUTH_REQUIRED` — access token 없음·만료·무효, 401
- `AUTH_FORBIDDEN` — 권한 부족, 403
- `AUTH_SESSION_REVOKED` — refresh session 폐기·재사용, 401
- `AUTH_ACCOUNT_DISABLED` — 비활성 계정, 403

계정 존재 여부를 추측할 수 있도록 로그인 오류 메시지를 다르게 만들지 않는다.

## 토큰과 세션 정책

- 짧은 수명의 JWT access token과 서버에 저장되는 refresh session을 사용한다.
- refresh token 원문은 DB에 저장하지 않고 강한 단방향 hash만 저장한다.
- refresh token은 회전하며, 사용된 token의 재사용이 감지되면 해당 session
  family를 폐기한다.
- access token은 `Authorization: Bearer`로 받는다.
- refresh token은 `HttpOnly`, `Secure(운영)`, 적절한 `SameSite`, 제한된 Path를
  가진 cookie로 전달한다. 브라우저 저장소에 refresh token을 두지 않는다.
- 로그아웃은 멱등적으로 처리하고 cookie를 제거한다.
- JWT secret, 만료 시간, cookie 설정은 검증된 환경변수로 관리한다.
- 비밀번호 hash는 Argon2id를 사용하고 원문·hash를 로그나 응답에 노출하지 않는다.
- auth 관련 endpoint에는 단순한 로그인 시도 제한 경계를 둔다. Redis는 도입하지
  말고 단일 인스턴스용 교체 가능한 메모리 adapter로 시작한다.

## Prisma 모델

최소 `User`, `Role` 또는 명확한 역할 표현, `RefreshSession`을 설계한다.
권한은 프론트의 문자열 permission(`dashboard:read` 등)과 호환되어야 한다.
Prisma 모델을 Controller 응답으로 직접 반환하지 말고 응답 DTO로 변환한다.

- 이메일은 정규화하고 unique constraint를 둔다.
- 비밀번호 hash와 session hash는 select/응답에서 실수로 노출되기 어렵게 한다.
- refresh session에는 만료, 폐기, family, 생성 시각, 최종 사용 시각을 추적한다.
- 첫 실제 migration을 작성하고 seed로 로컬 demo 계정을 만들되, 운영 비밀번호를
  코드에 넣지 않는다. seed 자격 증명은 개발용 환경변수 또는 명시적인 로컬 기본값과
  경고로 제한한다.

## 모듈 경계

`server/src/auth/` 아래에 controller, service, DTO, guards, decorators,
token/password/session 관련 adapter를 역할별로 분리한다.

- Controller는 cookie/header와 HTTP 변환만 담당한다.
- AuthService는 로그인·refresh·logout 유스케이스를 담당한다.
- JWT 검증과 password hashing은 교체 가능한 얇은 adapter 경계를 둔다.
- 현재 사용자를 request에 안전하게 전달하는 타입과 decorator를 제공한다.
- `@Public()`, permission metadata, authentication guard, permission guard를 만든다.
- 모든 route를 자동으로 막는 전역 guard 적용 여부는 기존 public health/docs 동작을
  고려해 결정하고 문서화한다.

## 테스트

단위 테스트:

- 정상 로그인과 잘못된 비밀번호
- 비활성 사용자
- access token 검증
- refresh 회전과 이전 token 재사용 탐지
- 로그아웃 멱등성
- permission guard 허용/거부
- 비밀번호·token·cookie 정보가 로그에서 마스킹되는지

E2E 테스트:

- login → session → refresh → logout 흐름
- 보호된 test route의 401/403/성공
- validation 오류 envelope
- 잘못된 refresh cookie
- 응답 cookie의 보안 속성

테스트는 개인 DB에 의존하지 않게 한다. 서비스 단위 테스트는 repository/Prisma
의존성을 대체하고, DB 제약을 증명하는 통합 테스트가 필요하면 Docker 기반 별도
명령으로 분리해 기본 E2E를 막지 않는다.

## 프론트 연결 범위

이번 단계에서는 MSW를 제거하지 않는다. 실제 서버 사용 여부를 환경변수로 선택할 수
있는 최소 연결만 허용하며 기본값은 기존 mock 동작을 유지한다. refresh와 cookie를
사용할 경우 Axios `withCredentials`, 401 재시도 동시성, 무한 재시도 방지를 설계하되
기존 auth store 공개 계약을 깨뜨리지 않는다.

## 문서와 검증

- `server/README.md`, `server/ARCHITECTURE.md`, 루트 `API_CONTRACT.md` 갱신
- auth 환경변수와 로컬 demo 계정 생성 방법 문서화
- Swagger에 bearer/cookie 인증과 오류 응답 문서화
- 기존 프론트 lint/typecheck/test/build
- 서버 lint/typecheck/build/unit/e2e
- Prisma validate, generate, migration 상태 확인
- OpenAPI 생성 및 변경 검토

## 최종 보고

1. 저장소·브랜치·초기 변경사항
2. 인증 흐름과 보안 결정
3. Prisma 모델과 migration
4. API 및 프론트 호환성
5. 테스트·검증 결과
6. 남은 제한사항
7. 3단계 대시보드에서 사용할 인증·권한 연결 지점
8. 변경 파일 목록

이번 단계에서는 커밋하거나 원격 브랜치에 push하지 않는다.

