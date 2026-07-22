# Kimi Desktop

Kimi의 데스크톱 GUI입니다. 앱이 자체 OAuth 로그인(auth.kimi.com, device flow)과 Anthropic 호환 API(api.kimi.com/coding) 직접 통신으로 동작하므로 **Kimi Code CLI 없이** 바로 사용할 수 있습니다. Swarm 등 고급 에이전트 기능이 필요하면 설정에서 [Kimi Code CLI](https://www.kimi.com) 기반의 'CLI 에이전트 모드'로 전환할 수 있습니다. Apple Human Interface Guidelines 기반의 차콜 프리미엄 테마(다크 기본, 라이트 옵션)를 적용했고, macOS와 Windows를 지원합니다. Electron + 순수 JavaScript(ES2022)로 작성했으며 번들러를 사용하지 않습니다. UI 기본 언어는 한국어이고 English를 지원합니다.

## 주요 기능

- **CLI 없이 바로 시작** — 첫 실행 시 브라우저 device-flow 로그인만으로 대화를 시작합니다. 자격증명은 CLI와 같은 파일(`~/.kimi-code/credentials/kimi-code.json`)에 저장되므로 앱과 CLI가 로그인을 공유합니다.
- **선택적 CLI 에이전트 모드** — 설정의 엔진 섹션에서 `kimi web` 서버 기반 모드로 전환할 수 있습니다. CLI가 설치되어 있지 않으면 앱이 공식 인스톨러(macOS: `install.sh`, Windows: `install.ps1`)로 설치를 지원합니다.
- **스트리밍 대화** — Claude Code 스타일의 전체 폭 트랜스크립트, 마크다운 렌더링, 실시간 스트리밍 응답, 중단(abort) 지원.
- **도구 승인 모달** — 에이전트가 요청하는 도구 실행 승인/거절을 모달로 처리합니다.
- **커스텀 그룹 + 세션 관리** — 사이드바가 세션을 작업 디렉터리(cwd) 기준 프로젝트별로 자동 그룹핑하고, 그 위에 사용자 정의 그룹을 만들어 드래그 앤 드롭으로 세션을 배치할 수 있습니다. 세션 이름 변경과 삭제(확인 모달)도 지원합니다.
- **대화 내용 검색** — ⌘F(Windows: Ctrl+F)로 전체 세션의 메시지를 검색하고, 결과를 클릭하면 해당 메시지 위치로 이동합니다.
- **에이전트 작업 패널** — 우측 패널에서 현재 실행 상태, 작업 목록, 최근 도구 활동, 변경된 파일을 실시간으로 확인합니다.
- **입력창 옵션** — 입력창 아래의 pill에서 세션별 모델, Swarm(CLI 에이전트 모드), 사고 수준(끄기/낮음/높음/최대)을 바로 조정합니다.
- **설정** — 언어(한국어/English), 테마(시스템/다크/라이트), 엔진 전환, 기본 모델, 계정(로그인 상태·재로그인), 업데이트 확인, 앱/CLI 정보를 관리합니다.
- **사용량 화면** — 오늘 사용량과 최근 7일 일별 차트, 계정 주간/5시간 롤링 쿼터, 세션별 토큰 사용량·컨텍스트 윈도우 점유율을 표시합니다.
- **디자인 패스** — 차콜 프리미엄 다크 테마, 본문 가독성 조정, 모든 아이콘·pill·지표에 툴팁 설명을 적용했습니다.
- **자동 업데이트** — GitHub Releases 기반(electron-updater). 실행 시 무음 검사 1회 + 설정에서 수동 확인이 가능합니다.

## 요구사항

- macOS 또는 Windows
- Node.js 20 이상 (개발/실행 환경)
- 인터넷 연결 (로그인, 모델 응답, 업데이트 확인에 필요)
- Kimi Code CLI는 **필수가 아닙니다.** CLI 에이전트 모드를 사용할 때만 필요하며, 설정에서 앱이 설치를 지원합니다. 수동 설치된 CLI가 있으면 그것을 사용합니다(`KIMI_CLI_PATH` 환경 변수 → `PATH`의 `kimi` → 기본 설치 경로 순으로 탐색).

## 실행

```bash
npm install
npm start
```

## 빌드

```bash
npm run dist
```

빌드 산출물은 `dist/`에 생성됩니다.

| 플랫폼 | 타깃 | 비고 |
| --- | --- | --- |
| macOS | DMG + ZIP | `npm run dist -- --mac --arm64 --x64`로 두 아키텍처 빌드. 자동 업데이트에는 ZIP이 필요 |
| Windows | NSIS 설치 프로그램 + 포터블 | macOS에서 크로스 빌드 가능: `npm run dist -- --win`(Wine이 필요할 수 있음). NSIS만 자동 업데이트 지원 |

배포 설정은 개발용으로 서명/공증을 비활성화한 상태(`hardenedRuntime: false`)이며, 빌드한 앱 실행 시 macOS Gatekeeper 경고가 표시될 수 있습니다.

## 아키텍처

main 프로세스의 **엔진 파사드**(`main/backend.js`)가 모든 세션/채팅 호출을 두 엔진 중 하나로 라우팅합니다. 선택된 엔진은 `<userData>/settings.json`에 저장되고, 설정에서 전환하면 앱이 다시 로드됩니다.

- **내장 엔진(direct, 기본)** — 외부 프로세스 없이 main 프로세스 안에서 동작합니다. `main/auth.js`가 auth.kimi.com 대상 RFC 8628 device flow로 로그인하고 액세스 토큰을 자동 갱신하며(CLI 호환 자격증명 파일, 원자적 쓰기), `main/direct-client.js`가 `api.kimi.com/coding/v1/messages`에 Anthropic Messages 형식의 SSE 스트리밍 요청을 전송하고 에이전트 루프(도구 실행 → 승인 → 결과 반환, 최대 25회 반복)를 수행합니다. 세션은 `main/direct-store.js`가 CLI의 `wire.jsonl`과 동일한 형식의 로컬 저장소(`<userData>/direct-sessions`)에 기록하므로, 검색·사용량 집계가 양 엔진의 세션을 같은 코드로 처리합니다.
- **CLI 에이전트 모드(cli)** — v1/v2 경로. 로컬에 설치된 Kimi Code CLI를 찾아 `kimi web --no-open --port <포트>`로 로컬 REST + WebSocket 서버를 spawn하고, stdout 배너(`Local: http://127.0.0.1:<포트>/#token=<토큰>`)에서 URL과 인증 토큰을 파싱해 이후 모든 통신에 사용합니다. REST(`<url>/api/v1`, `Authorization: Bearer` 헤더)는 세션·메시지·승인 등 요청-응답을, WebSocket(`/api/v1/ws`, subprotocol 인증)은 스트리밍 델타·승인 요청·사용량 갱신 등 서버 푸시를 담당합니다. 토큰은 로컬 서버와의 통신에만 쓰이며 외부로 전송되지 않습니다.
- **브리지** — preload 스크립트가 `contextBridge`로 `window.kimi` API만 노출합니다. renderer는 contextIsolation이 켜진 채 nodeIntegration 없이 동작하며, Swarm처럼 현재 엔진이 지원하지 않는 기능은 preload 결과에서 속성 자체가 빠져 UI가 숨깁니다.

프로토콜·검증 상세는 `docs/protocol.md`(CLI 서버), `docs/oauth.md`(device flow 로그인), `docs/direct-api.md`(direct 엔진 API)를 참고하세요.

## 파일 트리

```
├── package.json             # 앱 메타데이터, 실행/빌드 스크립트
├── electron-builder.yml     # 패키징 설정 (mac dmg/zip, win nsis/portable)
├── main/                    # Electron main 프로세스 (CommonJS)
│   ├── main.js              # 진입점: 윈도우 생성, 라이프사이클
│   ├── backend.js           # 엔진 파사드: direct/cli 라우팅 (ipc.js의 유일한 백엔드)
│   ├── auth.js              # OAuth device flow 로그인 + 토큰 갱신 (CLI 호환 자격증명)
│   ├── direct-client.js     # Anthropic 호환 API 직접 통신 + 에이전트 루프 (direct 엔진)
│   ├── direct-store.js      # wire 호환 로컬 세션 저장소 (direct 엔진)
│   ├── server-manager.js    # kimi web 서버 spawn/관리 (cli 엔진)
│   ├── kimi-client.js       # REST + WebSocket 클라이언트 (cli 엔진)
│   ├── ipc.js               # ipcMain 핸들러 (kimi:* 채널)
│   ├── preload.js           # contextBridge → window.kimi
│   ├── onboarding.js        # device flow 로그인 구동 + CLI 설치 지원
│   ├── search.js            # 세션 트랜스크립트 전문 검색 (양 엔진 저장소)
│   ├── usage-stats.js       # 일별 토큰 사용량 집계 (양 엔진 저장소)
│   ├── updater.js           # 자동 업데이트 (electron-updater)
│   └── quota.js             # 계정 할당량 조회 (best-effort)
├── renderer/                # UI (ES modules, script 태그 로드)
│   ├── index.html
│   ├── styles/              # Apple HIG 기반 CSS (차콜 프리미엄 다크 테마)
│   └── js/                  # app, sidebar, chat, markdown, approvals, usage,
│                            #   onboarding, search, panel, settings, chat-options, i18n
├── vendor/                  # marked, highlight.js 등 번들 라이브러리
├── assets/                  # 앱 아이콘 등 리소스
└── docs/
    ├── protocol.md          # kimi web 프로토콜 검증 노트 (cli 엔진)
    ├── oauth.md             # device flow 로그인 검증 노트 (direct 엔진)
    ├── direct-api.md        # Anthropic 호환 API 검증 노트 (direct 엔진)
    ├── quota.md             # 계정 쿼터 API 노트
    ├── update.md            # 자동 업데이트 동작/배포 문서
    ├── design.md            # 디자인 시스템
    ├── CONTRACT-V2.md       # v2 기능 계약
    ├── CONTRACT-V3.md       # v3 기능 계약
    └── ref/                 # openapi.json, asyncapi.json, webui-bundle.js 레퍼런스
```

## 업데이트 배포

자동 업데이트는 GitHub Releases(`kaminion/kimi-gui`)를 피드로 사용합니다. 릴리스하려면 `package.json`의 `version`을 올린 뒤 `GH_TOKEN` 환경 변수와 함께 `npm run dist -- --publish always`를 실행하면 electron-builder가 아티팩트와 업데이트 메타데이터(`latest-mac.yml`, `latest.yml`)를 Release에 업로드합니다. 공개 리포지토리이므로 클라이언트 측 확인/다운로드에는 토큰이 필요 없습니다. 상세 절차와 제약은 `docs/update.md`를 참고하세요.

## 알려진 제한

- **내장 엔진은 기본 도구 6종의 단일 턴 실행만 지원합니다.** Bash/Read/Write/Edit/Grep/Glob 도구로 한 번에 하나의 턴(에이전트 루프)만 처리하며, Swarm·서브에이전트·플랜 모드 등 고급 기능은 CLI 에이전트 모드가 필요합니다.
- **Windows 인스톨러 경로는 미검증 상태입니다.** NSIS/포터블 빌드와 Windows용 CLI 자동 설치(`install.ps1`) 경로는 실제 Windows 환경에서 검증되지 않았습니다.
- **일부 오류 메시지는 한국어로만 표시됩니다.** 로그인 진행/실패, CLI 설치 진행 등 main 프로세스에서 발생시키는 문자열 일부가 아직 i18n 테이블을 거치지 않습니다.
- **미서명 개발 빌드에서는 자동 업데이트 설치가 실패할 수 있습니다.** macOS의 자동 업데이트 설치 단계는 코드 서명 검증을 요구하므로, 실제 배포 시 Apple Developer ID 서명 + 공증이 필요합니다.
- **CLI 에이전트 모드에서 과거 세션의 토큰 수치가 0으로 표시될 수 있습니다.** kimi 0.28.1 데몬은 세션 토큰 집계를 REST(`GET /sessions/{id}`의 `usage` 등)로 제공하지 않아 재시작 후 로드한 세션의 토큰 수치는 실시간 이벤트(WebSocket)를 수신하는 동안에만 갱신됩니다. 내장 엔진 세션은 로컬 저장소에서 집계하므로 재시작 후에도 유지됩니다.
- **CLI 에이전트 모드에서 앱을 종료하면 앱이 띄운 로컬 `kimi web` 서버도 함께 종료됩니다.** 진행 중인 작업이 있다면 종료 전에 완료 여부를 확인하세요.
