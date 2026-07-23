# Kimi-GUI

![version](https://img.shields.io/badge/version-0.6.2-blue)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)
![Electron](https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white)
![made with](https://img.shields.io/badge/made%20with-vanilla%20JS%20%28no%20bundler%29-yellow)

[GitHub](https://github.com/kaminion/Kimi-GUI) · [English](README.md)

> [!NOTE]
> **Kimi-GUI는 커뮤니티 프로젝트이며, MoonshotAI의 공식 제품이 아닙니다.** Kimi Code API를 사용하며 Kimi Code CLI와 로컬 자격증명을 공유합니다.

Kimi-GUI는 [Kimi Code](https://www.kimi.com)를 터미널 없이 사용할 수 있게 해주는 오픈소스 데스크톱 GUI입니다. 프로젝트와 브랜치를 고르고 원하는 결과를 설명한 뒤, 실행 중인 작업을 조정하고 변경된 파일을 한 화면에서 검토할 수 있습니다. macOS와 Windows에서 동작하며 English UI가 기본이고 한국어를 완전히 지원합니다.

아래 데모는 Kimi 간편 로그인부터 공유 계정 확인, 두 엔진 선택, 실제 내장 엔진 응답, 에이전트 작업과 사용량 화면까지 이어지는 흐름을 보여줍니다.

![Kimi-GUI 데모 — Kimi 로그인, 두 엔진 선택, 스트리밍 응답, 에이전트 패널, 사용량 화면](docs/media/demo.gif)

## 시작하기

**요구사항**

- Node.js 20 이상
- macOS 또는 Windows
- 인터넷 연결 (로그인, 모델 응답, 업데이트 확인에 필요)
- Kimi 멤버십

**소스에서 실행**

```bash
npm install
npm start
```

**설치 파일 빌드**

```bash
npm run dist
```

빌드 산출물은 `dist/`에 생성됩니다: macOS는 DMG + ZIP, Windows는 NSIS 설치 프로그램 + 포터블 빌드입니다.

> [!IMPORTANT]
> 첫 실행 시 스플래시 화면이 표시되고 브라우저 device 로그인이 시작됩니다 — CLI가 필요 없습니다. 자격증명은 `~/.kimi-code/credentials`에 저장되어 Kimi Code CLI와 공유되므로, 한 번만 로그인하면 양쪽에서 모두 사용할 수 있습니다.

내장 엔진으로 시작하면 선택형 팝업 하나에서 CLI 에이전트 모드를 안내합니다. 연결 전에 Swarm 및 서브에이전트, Plan mode, 전체 CLI 도구, CLI 세션 연속성을 확인할 수 있습니다. CLI가 준비되어 있으면 **CLI 연결**, 없으면 **CLI 설치** 버튼이 표시되며 **다시 보지 않음**을 선택할 수 있습니다.

## Kimi-GUI 사용하기

새 대화의 입력창 위에서 프로젝트 디렉터리와 브랜치를 선택한 뒤 저장소에
기반한 질문으로 시작합니다.

```text
이 프로젝트의 인증 흐름을 설명하고 핵심 파일을 알려주세요.
```

수정이 필요하면 원하는 결과와 지켜야 할 조건을 함께 작성합니다.

```text
Windows 시작 오류를 수정하고 회귀 테스트를 추가하세요.
공개 API는 변경하지 마세요.
```

Kimi가 작업하는 중에도 입력창을 사용할 수 있습니다. Enter로 현재 작업에
조정 메시지를 보내고, 전달 전 짧은 대기 시간 동안 내용을 편집하거나
삭제할 수 있습니다.

```text
Kimi 서버가 미리 실행되지 않은 컴퓨터도 함께 처리하세요.
```

작업이 끝나면 입력창 바로 위 요약에서 변경된 파일 수와 추가·삭제 줄 수를
확인합니다. 요약을 누르면 우측 **변경사항** 탭에서 파일별 diff를 검토할 수
있고, 같은 패널의 **작업** 탭에서 실행 기록을 확인할 수 있습니다.

두 엔진과 전체 작업 흐름은 [사용 가이드](docs/kimi-code-made-easier.md)에서
스크린샷과 함께 볼 수 있습니다.

## 주요 기능

### Kimi Code, `kimi web`, Kimi-GUI의 관계

[Kimi Code](https://www.kimi.com/code/)는 기반 코딩 서비스이고, `kimi web`은 공식 Kimi Code CLI 런타임을 로컬 REST/WebSocket 서비스로 노출하는 명령입니다. Kimi-GUI는 이를 이용하는 독립적인 Electron 데스크톱 클라이언트로, Kimi Code API에 직접 연결하는 내장 엔진과 앱이 `kimi web`을 관리하는 CLI 에이전트 모드 중 하나를 선택할 수 있습니다.

설정에서 한 번의 클릭으로 엔진을 전환할 수 있으며, 전환 시 앱이 다시 시작됩니다:

| | 내장 엔진 (direct, 기본) | CLI 에이전트 모드 |
| --- | --- | --- |
| 의존성 | 없음 — 앱 안에서 완결 | Kimi Code CLI (앱이 설치를 지원) |
| 실행 방식 | Kimi-GUI 내부에서 직접 실행 | 앱이 공식 Kimi Code CLI를 실행·관리 |
| 통신 경로 | Kimi Code API에 직접 연결 | 로컬 `kimi web` REST + WebSocket |
| 로그인 | 한 번의 Kimi 로그인, CLI와 자격증명 공유 | 동일한 Kimi 자격증명 사용 |
| 도구 | 승인 다이얼로그를 거치는 로컬 도구 6종 (Bash/Read/Write/Edit/Grep/Glob) | 완전한 에이전트: 스웜, 서브에이전트, 플랜 모드 |
| 사고 수준 | 끄기 / 낮음 / 높음 / 최대 | CLI 설정에 따름 |
| 세션 | CLI 호환 wire 형식으로 로컬 저장 | CLI 세션 |

### 통합된 대화

CLI 시절의 세션이 내장 엔진 세션과 나란히 하나의 사이드바에 표시됩니다 — 열기, 이어하기, 이름 변경, 삭제 모두 가능합니다. 커스텀 그룹을 만들어 드래그 앤 드롭으로 세션을 정리할 수 있고, 그룹에 속하지 않은 세션은 최근 내역에 남습니다. ⌘F(Windows: Ctrl+F)로 전체 세션을 대상으로 전문 검색을 수행하고, 결과를 클릭하면 해당 메시지 위치로 이동합니다.

### 파일 변경 검토와 에이전트 작업 패널

Kimi가 문서나 코드를 수정하면 대화 안에 GPT/Codex 스타일의 변경 카드가
표시됩니다. 파일별 diff와 추가·삭제된 줄 수를 펼쳐볼 수 있고, 입력창 아래
옵션 행이 아니라 **입력창 바로 위 중앙**에 변경된 파일 수와 누적 `+`/`-`
줄 수가 표시됩니다.

요약 패널을 누르면 하나의 우측 패널에서 **변경사항** 탭이 열립니다. 같은
패널의 **작업** 탭에서는 현재 상태, 작업 목록, 최근 도구 활동과 변경된
파일을 실시간으로 확인할 수 있습니다.

### 입력창 옵션 pill

새 대화를 시작할 때만 입력창 위에서 최근 프로젝트 디렉터리와 로컬 Git
브랜치를 확인·선택할 수 있습니다. 대화가 시작되면 옵션 행에는 현재 작업
브랜치가 표시됩니다.

입력창 아래의 pill에서 설정을 열지 않고도 세션별 모델, 명확한 `Swarm
ON/OFF`(CLI 에이전트 모드), 사고 수준(끄기/낮음/높음/최대)을 바로
조정합니다. 답변 생성 중에도 입력창을 사용할 수 있으며, Enter로 현재
작업에 조정 요청을 보내고 별도의 중단 버튼으로 실행을 멈출 수 있습니다.
대기 중인 조정 요청은 엔진에 전달되기 전에 편집하거나 삭제할 수 있습니다.

### 사용량 화면

오늘의 토큰 사용량과 최근 7일 일별 차트, 주간 및 5시간 롤링 한도 바, 세션별 토큰·컨텍스트 윈도우 사용량을 표시합니다.

### 그 외

- English/한국어 UI (English 기본)
- 차콜 다크 테마, 라이트 옵션
- GitHub Releases 기반 자동 업데이트 확인

## 아키텍처

main 프로세스의 **엔진 파사드**(`main/backend.js`)가 모든 세션/채팅 호출을 내장 direct API 클라이언트 또는 로컬 `kimi web`을 사용하는 공식 CLI로 라우팅하며, 선택된 엔진은 `<userData>/settings.json`에 저장됩니다. preload 스크립트(`main/preload.js`)는 `contextBridge`를 통해 최소한의 `window.kimi` API만 노출합니다 — renderer는 `contextIsolation`이 켜진 채 `nodeIntegration` 없이 동작합니다.

설계·아키텍처 계약 문서는 `docs/`에 있습니다:

- [ARCHITECTURE.md](ARCHITECTURE.md) — 아키텍처 계약 (binding)
- [docs/protocol.md](docs/protocol.md) — `kimi web` REST + WebSocket 프로토콜 노트 (CLI 엔진)
- [docs/oauth.md](docs/oauth.md) — device flow 로그인 노트 (내장 엔진)
- [docs/direct-api.md](docs/direct-api.md) — Anthropic 호환 API 노트 (내장 엔진)
- [docs/update.md](docs/update.md) — 자동 업데이트 동작 및 배포 절차

## 개발

```bash
npm install        # 의존성 설치
npm start          # 앱 실행
npm run dist       # 설치 파일을 dist/에 빌드
node --check main/backend.js   # 파일 단위 문법 검사 (순수 JS, 빌드 단계 없음)
```

```
├── main/          # Electron main 프로세스 (CommonJS): 엔진 파사드, 인증,
│                  # direct 클라이언트/저장소, CLI 서버 관리자, IPC, 업데이터
├── renderer/      # UI (script 태그로 로드하는 ES 모듈): 채팅, 사이드바,
│                  # 설정, 사용량, 검색, i18n, 스타일
├── vendor/        # 번들 라이브러리 (marked, highlight.js)
└── docs/          # 설계/아키텍처 계약 및 프로토콜 노트
```

## 알려진 제한

- **내장 엔진은 도구 6종으로 한 번에 하나의 턴(에이전트 루프)만 처리합니다.** 스웜, 서브에이전트, 플랜 모드는 지원하지 않습니다 — 이런 기능은 CLI 에이전트 모드를 사용하세요.
- **Windows 경로는 미검증 상태입니다.** NSIS/포터블 빌드와 Windows용 CLI 자동 설치 경로는 실제 Windows 환경에서 검증되지 않았습니다.
- **개발 빌드는 서명되어 있지 않습니다.** macOS에서 Gatekeeper 경고가 표시되며, 코드 서명·공증 없이는 자동 업데이트 설치가 실패할 수 있습니다.
- **일부 main 프로세스 오류 문자열은 한국어로만 표시됩니다** (로그인 진행, CLI 설치 진행 등).
