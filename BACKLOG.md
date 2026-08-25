# BACKLOG

우선순위 없는 단순 목록. 코드상 확인되는 사실만 기록한다.

## 남은 개선 후보

- [ ] `npm run dev`에 watch/HMR 없음 — 매번 전체 빌드 후 electron 실행 (package.json)
- [ ] DevTools가 production에서도 F12로 열림 (src/backend/main.ts)
- [ ] `moveRun`이 런 폴더의 **최상위 파일만** 복사함 — 하위 폴더는 이동하지 않음 (src/backend/fs.ts)
- [ ] `exportRunMarkdown`이 폴더 경로 깊이(4세그먼트)를 가정해 헤더를 파싱함 (src/backend/fs.ts)
- [ ] 편집 탭 미저장 내용이 프로젝트 세션 전환/앱 종료 시 유실됨 — 종료 경고 없음
- [ ] Dogfooding 피드백 검색/Type 필터는 미지원 (Status 필터만 있음)
- [ ] drag-out은 사용자 제스처(mousedown)가 필요 — 키보드만으로는 불가
- [ ] 앱 아이콘 미설정 — electron-builder 기본 Electron 아이콘 사용 중 (build/ 리소스 필요)
- [ ] Work Tab 순서 영구 저장 — v0.3은 session-only (App.tsx onWorkTabDrop 주석 참조)
- [ ] 마지막 작업 탭(active tab)/선택 Agent까지 재실행 시 복원 — lastProject만 복원됨
- [ ] Drag Reorder 터치 지원 — v0.3은 HTML5 mouse DnD만 (Windows Desktop 우선 원칙)
- [ ] electron-updater 의존성 트리 자동 점검 — packaged app에 production deps 수집 누락 시 빌드만으로 감지 안 됨
- [ ] Quick Capture 저장 직후 pdMode가 닫혀있으면 알림만 표시 — 목록 확인은 다시 열어야 함

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
