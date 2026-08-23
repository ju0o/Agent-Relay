# Agent Relay

> GPT → 코딩 에이전트 작업을 **Prompt/Result Markdown 쌍**으로 기록하는 로컬 포터블 도구.
> DB 없음 · 클라우드 없음 · 파일시스템이 곧 데이터베이스.

Windows용 Electron 앱. Claude Code, Codex, OpenCode 등 에이전트에게 전달한 프롬프트와
그 결과를 날짜/에이전트/런(run) 단위로 자동 정리해준다.

## 현재 기능 (v0.2.0)

- **프로젝트 세션 탭** — 여러 프로젝트를 동시에 열고 전환
- **런(run) 관리** — `Project/Date/Agent/NN` 런 폴더 자동 생성·번호 관리(빈 번호 재사용 없음)
  - 폴더는 **실제 저장 시점에만** 생성된다 (앱을 열기만 해서 폴더가 만들어지지 않음)
- **병렬 편집 탭** (`Ctrl+T`) — 여러 에이전트의 런을 동시에 작업
- **Prompt/Result 저장** — 덮어쓰기 금지가 기본, 확인 후 허용
- **태그** — 성공/진행중/검토/실패/참고 프리셋, 런별 저장
- **마크다운 미리보기** — 외부 의존성 없는 자체 렌더러
- **파일 트리** — 최신순 히스토리, 검색 필터, 런 상태 점, 드래그로 다른 날짜/에이전트로 이동
- **Result → ChatGPT 전달**
  - 📤 `GPT로 드래그` 칩을 누른 채 ChatGPT 입력창에 놓으면 result.md가 파일 첨부처럼 전달됨 (OS 네이티브 drag-out)
  - `위치 열기` — 탐색기에서 result.md가 **선택된 상태**로 열림 (fallback)
  - `.md 내보내기` — prompt+result를 합쳐 단일 파일 저장
- **Dogfooding** 🐾 — 앱 자체 개선 기록 (아래 별도 섹션)
- **저장공간 자동 복원** — 마지막 DATA_ROOT/프로젝트 자동 복원, 경로 유실 시 안내 화면

## Windows 실행 방법

1. [Releases](https://github.com/ju0o/Agent-Relay/releases)에서 `AgentRelayLog.exe`(portable) 다운로드
2. 원하는 폴더에 두고 실행 (설치 불필요)
3. 최초 1회만 데이터 폴더(DATA_ROOT) 선택 — 이후 자동 복원

단축키: `Ctrl+S` 모두 저장 · `Ctrl+N` 새 런 · `Ctrl+T` 새 탭 · `F12` DevTools

## 개발 실행

```bash
npm install

# client(vite) + server(tsc) 빌드 후 electron 실행
npm run dev

# 타입 체크
npm run typecheck

# 테스트 (fs 레이어 + vnext 회귀)
npm test          # = npm run build && npm run test:fs && npm run test:vnext
```

## Build

```bash
npm run build        # tsc(server) + vite(client) → dist/

# Windows portable exe → dist/AgentRelayLog.exe
npm run build:win
# 또는 로그 래퍼: node scripts/build-win.mjs  (→ dist/buildwin.log)
```

## 데이터 저장 구조

파일시스템 자체가 SSOT다. 모든 기록은 사용자가 지정한 DATA_ROOT 아래에 쌓인다.

```text
DATA_ROOT/                          ← 설정에서 지정 (settings.json에 저장)
├─ {project}/                       ← 프로젝트 폴더
│  └─ YYYY-MM-DD/
│     └─ {agent}/                   ← 예: "Claude Code", "OpenCode"
│        ├─ 01/
│        │  ├─ prompt.md            ← GPT가 에이전트에게 준 프롬프트
│        │  ├─ result.md            ← 에이전트의 결과 보고
│        │  └─ meta.json            ← {"tags": [...]}
│        └─ 02/
└─ .agent-relay/                    ← 앱 내부 데이터 (프로젝트 목록에 나타나지 않음)
   └─ dogfooding/
      ├─ DF-0001.md                 ← 앱 자체 피드백 기록
      ├─ DF-0002.md
      └─ ...
```

- 특수 프로젝트 `'.'`: 프로젝트 하위 폴더 없이 `DATA_ROOT/{date}/{agent}/{NN}` 구조
- prompt.md = 작업 지시 기록, result.md = 결과 보고. **GPT 재전달 UX 대상은 result.md만**

## DATA_ROOT

- 모든 Agent Relay 기록이 저장되는 최상위 폴더. 외장 드라이브/동기화 폴더 어디든 가능.
- 최초 1회 선택 후 `settings.json`에 저장되어 매 실행 자동 복원된다.
- 경로가 사라지면(외장 드라이브 제거 등) "저장공간을 찾을 수 없습니다" 화면이 뜨고 새 위치만 다시 선택하면 된다.
- 변경은 ⚙ 설정 → Storage 에서 (Current Data Root 표시 + [변경] [폴더 열기]).

## Dogfooding 🐾

앱을 실제로 쓰면서 발견한 불편/개선점을 앱 안에서 바로 기록한다.

- 상단 `🐾 Dogfooding` 버튼 → 패널 전환
- `[+ Feedback]`: Type(Bug / UX·불편 / Improvement / Good / Other), Priority(LOW/MEDIUM/HIGH),
  내용, 원하는 동작(선택)
- 현재 작업 Context(Project/Date/Agent/Run)와 앱 버전이 자동 첨부된다
- 기록은 일반 프로젝트 데이터와 분리되어 `DATA_ROOT/.agent-relay/dogfooding/DF-NNNN.md`에 저장
  (markdown 파일이 SSOT)
- Status 클릭으로 순환 변경: `OPEN → FIXED → HOLD`
- 필터: ALL / OPEN / FIXED / HOLD
- 행별 `[복사]`(마크다운 전문 복사) / `[파일 열기]`(탐색기에서 해당 md 선택)

## Privacy / Local-first

- 네트워크 통신 없음. 계정 없음. telemetry 없음.
- 모든 데이터는 사용자가 지정한 로컬 폴더에 Markdown/JSON으로만 저장된다.
- ChatGPT 전달도 OS 파일 드래그일 뿐 — 앱이 대신 전송하거나 DOM을 조작하지 않는다.
- 설정 파일(`settings.json`)은 exe 옆에 생성되어 포터블하게 이동한다.
  (exe 폴더에 쓸 수 없는 경우에만 `%APPDATA%\agent-relay-log\AgentRelayLog`로 폴백)
