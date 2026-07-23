# Kimi-GUI 자동 업데이트 (`main/updater.js`)

`electron-updater` + GitHub Releases 기반 자동 업데이트. 구현은 `main/updater.js`이며,
CONTRACT-V2 §Auto-update를 따른다.

## 동작 흐름

- 패키징된 앱(`app.isPackaged === true`)에서만 실제로 동작한다. 등록(`register`) 10초 후
  자동으로 무음 검사 1회를 수행하고, 이후 검사는 설정 모달의 "업데이트 확인" 버튼(수동)으로만 이뤄진다.
- `autoDownload = false`다. 새 버전을 발견하면 렌더러가 업데이트 여부를 묻는 팝업을
  표시하고, 사용자가 "업데이트"를 선택한 뒤에만 `kimi:updateDownload`를 호출한다.
- 팝업은 다운로드 진행률을 표시하며 완료 후 "재시작 및 설치"로 전환된다. "나중에"를
  선택하면 같은 앱 실행 중에는 같은 버전을 다시 묻지 않고, 다음 실행 시 다시 확인한다.
- 다운로드가 끝나면 `autoInstallOnAppQuit` 덕분에 앱 종료 시 자동 설치되고, 사용자가 즉시
  설치를 원하면 팝업 또는 설정에서 `kimi:updateQuitAndInstall`을 호출한다.
- IPC 채널:
  - `kimi:updateCheck` → `{ status, version?, message? }`
  - `kimi:updateDownload` → 사용자가 동의한 업데이트를 다운로드하고 진행률 이벤트를 푸시
  - `kimi:updateQuitAndInstall` → 다운로드 완료 상태면 IPC 응답을 먼저 본 뒤
    `quitAndInstall(false, true)`(설치 후 앱 재실행)를 호출한다.
- 진행 상황은 푸시 이벤트(`kimi:event` 채널)로 전달된다:
  `{ type: 'update', status, version?, percent?, message? }`

### 상태(status) 값

| status        | 의미                                             |
| ------------- | ------------------------------------------------ |
| `dev`         | 개발 빌드이거나 업데이트 미설정/모듈 없음(정상)  |
| `checking`    | 업데이트 확인 중                                 |
| `available`   | 새 버전 발견, 사용자 선택 대기                    |
| `downloading` | 다운로드 중 (`percent` 동반)                     |
| `downloaded`  | 다운로드 완료, 설치 가능 (`version` 동반)        |
| `none`        | 최신 버전 사용 중                                |
| `error`       | 오류 (`message` 동반, 최대 300자로 절단)         |

### 개발/미설정 환경에서의 graceful degrade

다음 경우에는 예외 없이 항상 `{ status: 'dev' }`로 resolve된다(메인 프로세스가 절대 죽지 않음):

- `app.isPackaged === false`(개발 모드, `npm start`)
- `electron-updater`가 설치되지 않았거나 로드에 실패한 경우(lazy require + try/catch)
- 패키징은 됐지만 `app-update.yml`이 번들에 없는 경우(publish 미설정 빌드)

## 실제 릴리스를 위한 설정

### 저장소/피드

- 업데이트 피드는 GitHub Releases(`kaminion/Kimi-GUI`)다.
  `electron-builder.yml`의 `publish` 설정이 소유자와 저장소를 명시하며,
  패키징 시 `app-update.yml` 생성과 `--publish` 업로드에 사용된다.
- ⚠️ 주의: `package.json`에 `build` 키를 추가하면 `electron-builder.yml`이 **통째로
  무시**되므로 절대 추가하지 않는다. 명시적 설정이 필요하면 `electron-builder.yml`에
  `publish:` 섹션을 추가한다(해당 파일 소유자: packaging agent).
- `package.json`의 `repository`와 Git remote도 같은 저장소를 가리켜야 한다.

### 릴리스 절차

1. `package.json`의 `version`을 올린다(semver).
2. `GH_TOKEN`(repo 권한 PAT)을 환경 변수로 설정하고 빌드+업로드:
   `GH_TOKEN=… npm run dist -- --publish always`
3. electron-builder가 아티팩트와 함께 업데이트 메타데이터(`latest-mac.yml` — macOS,
   `latest.yml` — Windows/NSIS)를 Release에 업로드한다.
4. **공개 리포지토리이므로 클라이언트 측(업데이트 확인/다운로드)에는 토큰이 필요 없다.**
   `GH_TOKEN`은 배포(업로드)할 때만 필요하다.

### 필요한 빌드 타깃(현재 electron-builder.yml 기준)

- macOS: 자동 업데이트에는 **zip 타깃이 필수**(dmg는 업데이트 불가). 이미 `dmg` + `zip`
  둘 다 설정되어 있다.
- Windows: NSIS 타깃은 자동 업데이트 지원. `portable` 타깃은 자동 업데이트 미지원.

## 현재 제약 사항

- **미서명 개발 빌드**: macOS에서 자동 업데이트 설치 단계는 코드 서명 검증을 요구한다.
  서명/공증 없는 개발 빌드(`hardenedRuntime: false`)에서는 다운로드 후 설치가 실패하며
  `error` 상태로 표시된다. 실제 배포 시 Apple Developer ID 서명 + notarization이 필요하다.
- Release에서 플랫폼별 업데이트 메타데이터(`latest-mac.yml` 또는
  `latest.yml`)가 누락되면 해당 플랫폼의 업데이트 검사가 실패한다.
- 동시에 여러 검사가 요청되면 진행 중인 검사를 공유한다(중복 실행 안 함).
- 동시에 여러 다운로드가 요청되면 진행 중인 다운로드를 공유한다(중복 실행 안 함).
- 업데이트 오류 메시지는 300자로 절단해 푸시하며, 토큰 등 비밀 값은 로깅하지 않는다.
