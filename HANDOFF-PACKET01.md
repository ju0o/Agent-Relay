# Packet 01 진행 상태 핸드오프 (2026-08-26)

이 문서는 dev 작업을 이어서 하기 위한 스냅샷이다. 작업 디렉터리:
`C:\Users\user\Desktop\agent-relay-log-dev01` (worktree, branch: `dev/adapter-foundation-01`)

## 1. Git 상태

- STABLE_BASELINE_HEAD = `d16c60c` (v0.3.1 태그와 동일)
- main 브랜치/체크아웃: **건드리지 않음** (`d16c60c` 그대로, untracked `.commandcode/`만 존재 — 보존됨)
- 개발 worktree: `C:\Users\user\Desktop\agent-relay-log-dev01`, branch `dev/adapter-foundation-01`
- **아직 커밋 안 됨** — 변경 전부 워킹트리에 있음 (수정 8파일 + 신규 4경로)
- node_modules는 dev worktree에 `npm ci`로 설치 완료

## 2. 구현 완료 (typecheck/build/test 모두 통과)

신규:
- `src/integrations/core/types.ts` — AgentCompletion, CompletionKind(5종), AdapterEvent/Phase, AgentAdapter, WatchHandle, CaptureOutcome
- `src/integrations/core/registry.ts` — registerAdapter/getAdapter/listAdapters/clearAdapters
- `src/integrations/core/validate.ts` — validateAgentCompletion (런타임 검증)
- `src/integrations/core/capture.ts` — captureCompletion: agent-result.md(원문 불변) + result.md(없을 때만 미러) + evidence/adapter.json(dedupeKey 기반 중복 방지). 절대 덮어쓰기 없음, throw 없음
- `src/integrations/opencode/extract.ts` — 순수 함수: summarizeLastTurn/pickLastTurn/messageText. 턴=마지막 user 이후, 완료 경계=마지막 assistant의 info.time.completed, error.name==MessageAbortedError→INTERRUPTED
- `src/integrations/opencode/client.ts` — opencode serve 로컬 스폰 클라이언트. stdout에서 "opencode server listening on http://..." 파싱으로 자기 서버만 신뢰. win32는 `.cmd` 셈 대신 `opencode.exe` 직접 스폰(taskkill /T로 확실히 죽음). 포트 47800~47809 후보
- `src/integrations/opencode/watch.ts` — OpenCodeAdapter(폴링 2s, 타임아웃 120분) + selectCandidateSessions(순수)
- `src/backend/capture-manager.ts` — CaptureManager: 어댑터↔run 폴더 바인딩, 캡처 성공 시 원샷 disarm
- `scripts/smoke-capture.mjs` — 라이브 통합 스모크(미완, 아래 4번)
- `test/adapter.test.mjs` + `test/fixtures/opencode/*.json` — 패킷 요구 9케이스 전부 PASS

수정:
- `src/shared/types.ts` — RelayRequest에 adapters:list / capture:arm / capture:disarm 추가, CaptureStatusView 추가
- `src/backend/main.ts` — ops 3개 위임 + whenReady에서 CaptureManager 생성 + 종료 시 dispose
- `src/backend/preload.ts`, `src/frontend/bridge.ts` — onCaptureStatus 푸시 구독
- `src/frontend/App.tsx` — 결과 패널 헤드에 최소 UI: "🤖 자동수신" 버튼 → "● OpenCode 수신 대기" → "✓ 자동수신됨", 수신되면 result.md를 에디터에 로드(result.md 미기록 시 agent-result.md 알림만)
- `src/frontend/style.css` — .cap-live/.cap-done 2줄
- `tsconfig.server.json` — include에 src/integrations 추가
- `package.json` — test:adapter 추가, test 체인에 포함

검증 상태: `npm run typecheck` ✅, `npm run build` ✅, `npm test`(fs+vnext+v03+adapter) ✅ 전부 통과.

## 3. OpenCode 디스커버리 결과 (1.18.23 실측, 증거 확보)

- 세션은 TUI(`--yolo`)와 CLI 모두 동일 저장소에 실시간 저장됨. `ses_*` 안정적 ID.
- GET /session, GET /session/:id/message 가 `opencode export`와 동일한 `{info,parts}` JSON 제공.
- 완료 경계: 진행 중 assistant 메시지는 time.completed=undefined → 끝나면 값이 생김. error.name==MessageAbortedError면 중단.
- **핵심 발견**: serve의 GET /session 은 프로세스 cwd의 git 루트 프로젝트로 스코핑됨. git 없는 neutral 디렉터리에서 띄우면 **전체 세션 글로벌 뷰** → client.ts는 workspaceRoot 없으면 임시 neutral dir에서 스폰하도록 구현됨.
- npm `.cmd` 셸은 실 서버(opencode.exe)를 분리 스폰해 좀비가 남음 → exe 직접 스폰으로 해결. 예전 좀비들은 이미 정리함(CIM으로 확인, 현재 0개).
- 플러그인/설정 변경 불필요 — 수동 폴링만으로 완료 감지 가능. OPENCODE_NATIVE_CAPTURE_REQUIRES_PLUGIN=false.

## 4. 남은 문제 — 다음 세션 첫 작업

**증상**: scripts/smoke-capture.mjs가 CaptureManager 체인으로 실제 턴 완료를 놓침(타임아웃). 
반면 동일 컴파일 모듈(client+selectCandidateSessions+summarizeLastTurn)을 쓴 디버그 복제본은 6초 만에 DBG_OK 완료를 감지함.

**유력 원인 (구현 수정 필요)**:
watch.ts tick()이 후보 세션 각각에 listMessages를 호출하는데, 하나라도 실패하면 전체 pass가 catch로 건너뛰어 늦은 순서의 세션(작은 워크로드 세션)을 계속 못 볼 수 있음. 내 거대 활성 세션(수백 KB, 매 폴맔 갱신)이 목록 앞쪽에서 타임아웃을 유발하는 것이 의심됨.

**계획된 수정 (watch.ts)**:
1. per-session try/catch (한 세션 실패가 pass 전체를 중단하지 않게)
2. 후보를 time.updated 내림차순 정렬 후 조회 (새로운 작은 세션 우선)
3. 메시지 조회 timeout 8s→12s 여유
4. smoke-capture.mjs에 폴당 candidate 요약 로그 추가해 재검증

참고: 워크로드 턴이 내 세션의 모델 요청과 큐 경합을 해서 완료 자체가 수 분 지연되는 외교란 변수도 있었음(3회 스모크 모두 직전/직후 완료). 감지 로직 자체는 복제본에서 이미 실증됨.

## 5. 다음 단계 체크리스트

- [ ] watch.ts 폴링 견고화(위 4항목) 후 재빌드
- [ ] smoke-capture.mjs 재실행 → CAPTURED 확인 (result.md 미러까지)
- [ ] npm run typecheck && npm test && npm run build 재확인
- [ ] Electron 실행(npm run dev)해서 UI 플로우 수동 확인: 저장된 런 → 🤖 자동수신 → opencode run 한 턴 → 결과 패널 자동 채움 + GPT 드래그 버튼 동작
- [ ] 스코프 스테이징 커밋 (src/integrations, backend, frontend, shared, test, scripts, tsconfig, package.json)
- [ ] 최종 리포트 작성 (ADAPTER_FOUNDATION_IMPLEMENTED=true, OPENCode_NATIVE_CAPTURE_IMPLEMENTED, LEGACY_RESULT_WORKFLOW_PRESERVED 등)

## 6. 주의사항

- DATA_ROOT 실데이터는 건드린 적 없음 (모든 테스트는 .test-data-root/ 및 TEMP 사용)
- 스모크/디버그로 생성된 Temp 폴더들(agent-relay-smoke*, agent-relay-dbg-ws*, agent-relay-oc-view*)은 TEMP 안에 있으니 나중에 일괄 삭제 가능
- opencode 세션 저장소에 테스트 세션 몇 개(Temp 경로)가 남음 — 사용자 데이터 아님, 삭제 불필요
- 커밋은 사용자 승인 후 스코프 스테이징으로 할 것 (push 금지)
