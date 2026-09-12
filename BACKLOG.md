# BACKLOG

우선순위 없는 단순 목록. 코드상 확인되는 사실만 기록한다.

## 남은 개선 후보 (Owner 판단 필요 — flagged, 미착수/부분)

- [ ] 앱 아이콘 미설정 — electron-builder 기본 Electron 아이콘 사용 중 (build/ 리소스 필요)
      ※ 배선만 완료 (`resolveWindowIcon` — `public/icon.png` 있으면 자동 사용).
      실제 아트워크(`build/icon.ico` + `win.icon` 설정) 확정 필요 → Owner 판단 요청.
- [ ] Work Tab 순서 영구 저장 — v0.3은 session-only (App.tsx onWorkTabDrop 주석 참조)
      ※ 탭 자체가 재실행 시 복원되지 않으므로 순서만 저장해도 효과 없음.
      탭 내용 영속 여부와 함께 설계 결정 필요 → Owner 판단 요청.
- [ ] Drag Reorder 터치 지원 — v0.3은 HTML5 mouse DnD만 (Windows Desktop 우선 원칙)
      ※ Pointer Events 전면 개편이 필요해 V1 안정 UI 변경 리스크 있음.
      Windows Desktop 우선 원칙상 deferred 권장 → Owner 판단 요청.
- [ ] 편집 탭 미저장 초안의 재실행 후 복원 (crash-safe draft persistence)
      ※ 종료 경고(`beforeunload`)는 완료. 디스크 영속은 저장 스키마 설계 문제 → Owner 판단 요청.
- [ ] 마지막 작업 탭(active tab) 전체 복원 — lastProject/lastAgent만 복원됨
      ※ 탭 내용 영속과 동일 설계 문제 → Owner 판단 요청.

## 완료된 것 (v0.3.2 — BACKLOG 정리)

- [x] `npm run dev`에 watch/HMR — `dev:client`/`dev:server`/`dev:hmr` 추가 + `ELECTRON_START_URL` 분기 (package.json, main.ts)
- [x] DevTools가 production에서도 F12로 열림 → dev-only 게이트 (`shouldEnableDevToolsShortcut`) (src/backend/main.ts)
- [x] `moveRun`이 런 폴더의 **최상위 파일만** 복사함 → 하위 폴더 재귀 복사 (src/backend/fs.ts)
- [x] `exportRunMarkdown`이 폴더 경로 깊이(4세그먼트)를 가정해 헤더를 파싱함 → 끝에서부터 해석 + 짧은 경로 내성 (src/backend/fs.ts)
- [x] 편집 탭 미저장 내용이 앱 종료 시 유실됨, 종료 경고 없음 → dirty tracking + `beforeunload` 경고 (App.tsx)
- [x] Dogfooding 피드백 검색/Type 필터 미지원 → Type 필터 + 텍스트 검색 추가 (dogfooding.tsx)
- [x] drag-out은 사용자 제스처(mousedown)가 필요, 키보드만으로는 불가 → Enter/Space 동작 + 경로 복사 대체 버튼 (App.tsx)
- [x] 마지막 선택 Agent 재실행 시 복원 — `lastAgent` 설정 persist + 초기 탭/새 탭 적용 (types.ts, main.ts, App.tsx)
- [x] electron-updater 의존성 트리 자동 점검 → `npm run check:updater` 스크립트 (scripts/verify-updater-deps.mjs)
- [x] Quick Capture 저장 직후 pdMode가 닫혀있으면 알림만 표시 → 저장 후 목록 자동 표시 (App.tsx)

## 완료된 것 (v0.2.0)

- [x] Claude Code 등 에이전트 폴더가 앱 탐색만으로 선생성되던 문제 → 저장 시점 생성으로 변경
- [x] DATA_ROOT 매 실행 선택/유실 문제 → settings.json 자동 복원 + 유실 안내 화면
- [x] 마지막 프로젝트 자동 복원
- [x] Result → ChatGPT 1-제스처 전달 (native drag-out) + Explorer reveal fallback
- [x] Dogfooding 기록 기능

## 완료된 것 (v0.2.1)

- [x] Project Dogfooding — 프로젝트별 `{project}/_dogfooding/` 사용성 기록
      (프로젝트별 독립 ID, Agent/Run optional Context, App 스트림과 완전 분리)

## 완료된 것 (v0.3.0)

- [x] Windows 설치형(NSIS) — 시작 메뉴/바탕화면 바로가기, 설치 경로 선택 가능
- [x] 설치형 설정 위치를 Electron userData로 이동 + 포터블 settings.json 비파괴 migration
- [x] GitHub Release 기반 in-app updater (electron-updater · 사용자 클릭 기반 다운로드/설치)
      ※ private repo 동안은 Release 조회가 인증을 요구하므로 실제 업데이트 E2E는 BLOCKED_PRIVATE_REPO
- [x] GitHub Actions tag(v*) push → build/test/packaging/Release 자동화
- [x] Quick Dogfooding Capture (`＋ 피드백` Popover — 한 줄 기록, UX/MEDIUM/OPEN 기본값)
- [x] Drag Reorder — 프로젝트 탭(영구), 작업 탭(session), 에이전트 목록(영구)

## 완료된 것 (v0.3.1)

- [x] NSIS one-click 전환 — 설치 경로 선택 UI 제거 (Setup → 자동 설치 → 실행)
- [x] 프로그램 본체를 `%LOCALAPPDATA%\Programs\Agent Relay\`에 설치
      (build/installer.nsh customInit — 신규 설치만 리다이렉트, 업그레이드는 레지스트리 InstallLocation 존중)
- [x] 제거 시 사용자 데이터 미삭제 확인 (`deleteAppDataOnUninstall: false` + DATA_ROOT는 설치 디렉터리 외부)
- [x] 실제 Windows E2E: 설치→단축키→설치된 앱 등록→실행→복원→제거→데이터 보존→재설치 재연결

## 알려진 사항

- v0.3.0 NSIS로 설치한 적이 있는 환경은 업그레이드 시 구 위치(`%LOCALAPPDATA%\Programs\agent-relay-log`)에
  그대로 설치된다(업그레이드는 항상 기존 위치 존중). 새 위치를 원하면 구버전 제거 후 재설치.
- NSIS 언인스톨러는 빈 폴더 껍데기를 남길 수 있다(파일 없음, 무해).
