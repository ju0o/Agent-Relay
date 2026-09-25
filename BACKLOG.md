# BACKLOG

## CORE V1 Auto Night Run — Founder authorization 2026-09-23

Authorized bounded operations phase. Product scope remains unchanged; the
existing CORE V1 PM → Worker → RESULT_PACKET → independent QA → ACCEPT/NEXT
runner remains the only execution engine. Active lanes are Agent Relay, actl,
JuPlan, and JuCeipt. JuControler is not active.

- [x] NR-01 supervisor: existing `runOnce`, WBS exhaustion, deadline boundary, `LAST_NIGHT_RUN.json`
- [x] NR-02 loop: retry/ACCEPT/NEXT through the existing runner
- [x] NR-03 drain: Agent Relay-managed processes and panes only
- [x] NR-04 resume: reconcile checkpoint and preserve unfinished worktrees
- [x] NR-05 deadline: injectable 02:55 freeze, 02:58 checkpoint, 03:00 hard stop
- [x] NR-06 ASUS: narrow non-interactive shutdown handoff, fail closed if missing
- [x] NR-07 MainPC: `core-night` wrapper with completion-integrity gate
- [x] NR-08 independent safety QA

Safety setup is intentionally Founder-run: see `docs/CORE_V1_AUTO_NIGHT_RUN.md`.

우선순위 없는 단순 목록. 코드상 확인되는 사실만 기록한다.
2026-09-24 회고 기준 13개 중 10개 완료 — 완료 항목은 증거 커밋/위치를 함께 남긴다.

## 남은 개선 후보

- [ ] `npm run dev`에 watch/HMR 없음 — 매번 전체 빌드 후 electron 실행 (package.json:11)
- [x] DevTools가 production에서도 F12로 열림 → development 전용으로 제한 (17afb3b, src/backend/main.ts:462-473 `if (!app.isPackaged)`)
- [ ] `moveRun`이 런 폴더의 **최상위 파일만** 복사함 — 하위 폴더는 이동하지 않음 (src/backend/fs.ts:381-384; 후속 AGENTRELAY-V1-MOVE-RUN-RECURSIVE가 config/portfolio.json에 대기 중)
- [x] `exportRunMarkdown`이 폴더 경로 깊이(4세그먼트)를 가정해 헤더를 파싱함 → 끝에서부터 상대 인덱싱 + `?? ''` 폴백으로 앱이 만드는 레이아웃에서 충돌 없이 동작 (src/backend/fs.ts:298-303; 희귀 중첩 경로 하드닝은 AGENTRELAY-V1-EXPORT-NESTED-PATH로 추적)
- [x] 편집 탭 미저장 내용이 프로젝트 세션 전환/앱 종료 시 유실됨 → 세션 전환 확인 + 앱 종료 경고 (`will-prevent-unload` + `beforeunload`) (778c6ab, src/frontend/App.tsx:896-918, src/backend/main.ts:485-494)
- [x] Dogfooding 피드백 검색/Type 필터는 미지원 → 검색 + Type 필터 추가 (06a212f, src/frontend/dogfooding.tsx)
- [x] drag-out은 사용자 제스처(mousedown)가 필요 — 키보드만으로는 불가 → 키보드(Enter/Space)로 결과 전달 폴백 실행 가능 (ca0052f, src/frontend/App.tsx GPT로 드래그 버튼 onKeyDown)
- [ ] 앱 아이콘 미설정 — electron-builder 기본 Electron 아이콘 사용 중 (build/ 리소스 필요; electron.builder.yml에 icon 없음)
- [x] Work Tab 순서 영구 저장 — v0.3은 session-only → `settings:setWorkTabOrder`로 영구 저장 (96436e2, src/backend/main.ts:133-138, src/shared/types.ts:31)
- [x] 마지막 작업 탭(active tab)/선택 Agent까지 재실행 시 복원 — lastProject만 복원됨 → 마지막 선택 Agent 저장 + workTabOrder로 탭 복원 (25103eb + 96436e2, `agent-relay:last-agent` in src/frontend/App.tsx:125-131, 적용은 applySettings)
- [x] Drag Reorder 터치 지원 — v0.3은 HTML5 mouse DnD만 → Pointer Events fallback으로 터치/펜 지원 (b80232b + 80f08c5, src/frontend/App.tsx shouldStartPointerReorder/resolvePointerDropIndex)
- [x] electron-updater 의존성 트리 자동 점검 — packaged app에 production deps 수집 누락 시 빌드만으로 감지 안 됨 → `npm test`가 production dep + `dist/server` 포함을 검사 (9832a4f, test/v03.test.mjs P1/P2)
- [x] Quick Capture 저장 직후 pdMode가 닫혀있으면 알림만 표시 → 저장 후 Project Dogfooding 목록을 바로 열어 보여줌 (e09b3f2, src/frontend/App.tsx:1723-1727 onSaved)

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
