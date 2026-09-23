# Agent Relay

> 한 사람이 여러 AI 코딩 에이전트를 굴릴 때, **무엇이 끝났는지 상태로 남는** 로컬 오케스트레이션 런타임.
> 클라우드 없음 · 외부 DB 없음 · 파일시스템이 상태 저장소.

ChatGPT를 **PM** 역할로, Claude Code / Codex 를 **Builder** 역할로 두고 Task 계약 단위로 일을 흘린다.
Electron 앱 · CLI · TUI · MCP 서버 네 개의 표면을 가진다.

---

## 무엇을 푸는가

AI 에이전트가 코드를 쓰는 건 이미 된다. 무너지는 건 그다음이다.

- 에이전트가 "완료했습니다"라고 말해도 **무엇이 실제로 검증됐는지** 알 수 없다
- 여러 에이전트를 동시에 돌리면 **누가 무엇을 어디까지 했는지** 사람이 추적할 수 없다
- 프로세스가 죽으면 **진행 중이던 작업이 어디로 갔는지** 모른다

Agent Relay는 이 세 가지를 지시·판정·복구가 **상태로 남는 구조**로 바꾼다.

## 작동 흐름

```
Owner GO
   └─> PM 지시 (Task 계약 생성)
          └─> Builder 실행 (Claude Code / Codex)
                 └─> 결과 캡처 (RESULT_PACKET 검증)
                        └─> PM 판정
                               ├─ ACCEPT           → 완료
                               ├─ REQUEST_CHANGES  → 같은 Task 자동 재시도
                               └─ HUMAN_GATE       → 사람에게 올림
```

PM이 낼 수 있는 판정은 `DISPATCH` · `REQUEST_CHANGES` · `ACCEPT` · `HUMAN_GATE` ·
`MILESTONE_COMPLETE` **다섯 개로 fail-closed 고정**이다. 그 외 응답은 전부 거부된다.
세션 식별자는 `project + role + runtime + live_session_identity` 이며,
프로세스 이름으로 워커를 추측하지 않는다.

## 지금 상태 — 잰 값과 안 된 것

| | 값 | 근거 |
|---|---|---|
| 커밋 | 337 | 전체 브랜치 기준 |
| 프로덕션 코드 | 175 파일 / 53,719 줄 | `src/` |
| 테스트 코드 | 111 파일 / 35,514 줄 (프로덕션의 66%) | `test/` |
| 테스트 파일 | 119 | `test/` |
| V1 회귀 | 602 assertions PASS | `FINAL_CERTIFICATION_REPORT.md` |
| V1.5 회귀 | 160 assertions PASS | 동일 |
| V1.6 회귀 | 479 assertions PASS | 동일 |
| 미해결 결함 | P0 0 · P1 0 · P2 0 · P3 0 | 동일 |
| 내구성 | 실제 SIGKILL 후 별도 프로세스 재개 PASS (10 seams, 26 checks) | 동일 |
| 멱등성 | 동시 제출 포함 PASS (7 groups, 14 checks) | 동일 |
| typecheck / build | PASS (clean) | `npm run typecheck` / `npm run build` |

### 안 된 것도 적는다

```
Bootstrap Final Closure: BLOCKED_BY_TRANSPORT. ACCEPT 선언 없음.
```

라이브 루프는 `STATE_PACKET → PM → DISPATCH → Builder → RESULT_PACKET` 까지 도달했고
PM 리뷰도 수행됐다. 그러나 **PASS 결과 이후의 최종 PM 리뷰가 전송 계층 끊김으로 두 번 실패**했고,
재시도 예산을 소진해 자율 야간 실행에 진입하지 못했다.
자세한 내용: [`AGENT_RELAY_FINAL_RESULT.md`](AGENT_RELAY_FINAL_RESULT.md)

이 저장소는 되는 것과 안 되는 것을 같은 크기로 적는다.
인증 리포트는 구현자가 아닌 **별도 인증 역할**이 작성했고, 인증 중
프로덕션 코드 수정이 0건이었음을 `git diff --stat -- src/` 로 증명했다.

## 구조

| 디렉터리 | 역할 |
|---|---|
| `src/orchestrator/` | PM 판정 스키마, 역할 루프, 자율 액션 |
| `src/integrations/` | 역할 런타임 어댑터 (tmux 외부 세션 등) |
| `src/mcp/` | MCP 서버 표면 (PM / Worker) |
| `src/runner/` | 실행·복구 런너 |
| `src/workspace/` | 워크스페이스 부트스트랩 |
| `src/tui/` | 터미널 UI |
| `src/cli/` | `agent-relay` CLI |
| `src/backend/`, `src/frontend/` | Electron 앱 (Prompt/Result 기록 표면) |
| `docs/` | WBS·스펙·인증 리포트·교차 리뷰 기록 |

## 실행

```bash
npm install
npm run build        # tsc server + vite client
npm run typecheck
npm test             # build + 필수 테스트 스위트
```

Electron 앱:

```bash
npm run dev
```

Windows 설치형은 [Releases](https://github.com/ju0o/Agent-Relay/releases) 참고.
코드 서명 인증서가 없어 최초 설치 시 SmartScreen 경고가 뜬다.

## Prompt / Result 기록 표면

Electron 앱은 에이전트에게 준 프롬프트와 결과를 날짜/에이전트/런 단위로 정리한다.
모든 기록은 사용자가 지정한 `DATA_ROOT` 아래에 쌓이며, 프로그램 본체와 완전히 분리된다.
제거·업데이트해도 기록은 삭제되지 않는다.

```
DATA_ROOT/
└─ {project}/
   └─ YYYY-MM-DD/
      └─ {agent}/
         └─ 01/
            ├─ prompt.md
            ├─ result.md
            └─ meta.json
```

## 만든 사람

황주영 (Ju0) · [github.com/ju0o](https://github.com/ju0o)
