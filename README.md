# Agent Relay

> GPT → 코딩 에이전트 작업을 **Prompt/Result Markdown 쌍**으로 기록하는 로컬 포터블 도구.
> DB 없음 · 클라우드 없음 · 파일시스템이 곧 데이터베이스.

Windows용 Electron 앱. Claude Code, Codex, OpenCode 등 에이전트에게 전달한 프롬프트와
그 결과를 날짜/에이전트/런(run) 단위로 자동 정리해준다.

## 현재 기능 (v0.2.1)

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
- **Dogfooding 🐾** — App / Project 두 종류 (아래 별도 섹션)
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
│  ├─ YYYY-MM-DD/
│  │  └─ {agent}/                   ← 예: "Claude Code", "OpenCode"
│  │     ├─ 01/
│  │     │  ├─ prompt.md            ← GPT가 에이전트에게 준 프롬프트
│  │     │  ├─ result.md            ← 에이전트의 결과 보고
│  │     │  └─ meta.json            ← {"tags": [...]}
│  │     └─ 02/
│  └─ _dogfooding/                  ← 이 프로젝트의 사용성 피드백 (Work Log와 분리)
│     ├─ DF-0001.md
│     └─ DF-0002.md
└─ .agent-relay/                    ← 앱 내부 데이터 (프로젝트 목록에 나타나지 않음)
   └─ dogfooding/
      └─ DF-NNNN.md                 ← Agent Relay 앱 자체 피드백
```

- 특수 프로젝트 `'.'`: 프로젝트 하위 폴더 없이 `DATA_ROOT/{date}/{agent}/{NN}` 구조
- prompt.md = 작업 지시 기록, result.md = 결과 보고. **GPT 재전달 UX 대상은 result.md만**

## DATA_ROOT

- 모든 Agent Relay 기록이 저장되는 최상위 폴더. 외장 드라이브/동기화 폴더 어디든 가능.
- 최초 1회 선택 후 `settings.json`에 저장되어 매 실행 자동 복원된다.
- 경로가 사라지면(외장 드라이브 제거 등) "저장공간을 찾을 수 없습니다" 화면이 뜨고 새 위치만 다시 선택하면 된다.
- 변경은 ⚙ 설정 → Storage 에서 (Current Data Root 표시 + [변경] [폴더 열기]).

## Dogfooding 🐾

두 종류가 있으며 **데이터가 절대 섞이지 않는다**.

### App Dogfooding (앱 자체 개선)

Agent Relay 프로그램 자체를 쓰면서 발견한 Bug/UX/Improvement 기록.

- 상단 `🐾 App Dogfooding` 버튼
- 저장: `DATA_ROOT/.agent-relay/dogfooding/DF-NNNN.md`
- Type: Bug / UX·불편 / Improvement / Good / Other

### Project Dogfooding (프로젝트 사용성)

관리 중인 실제 프로젝트(HERMESS, JuTell 등)를 **직접 사용하면서** 발견한 문제/불편/아이디어를
프로젝트별로 기록. Work Log(prompt/result)와는 목적이 다른 Product Feedback Log다.

- 프로젝트 선택 후 상단 `📋 Project Dogfooding` 버튼 (프로젝트 미선택 시 비활성)
- 저장: `DATA_ROOT/{project}/_dogfooding/DF-NNNN.md` — **프로젝트마다 독립적인 ID 체계**
- Type: Bug / UX·Friction / Improvement / Idea / Good / Other
- Context: Project 필수 자동 기록 + Date/Agent/Run은 있을 때만 자동 첨부 (Run 없이 기록 가능)
- Status 클릭 순환 변경: `OPEN → FIXED → HOLD`, 필터 ALL/OPEN/FIXED/HOLD, 상태별 개수 표시
- 행의 ▸ 클릭으로 전체 내용 보기, `[복사]`(md 전문) / `[파일 열기]`(탐색기 reveal)
- markdown 하나만 읽어도 어느 프로젝트의, 어떤 상황에서 발견한, 어떤 심각도의, 지금 어떤 상태인지
  기록이 모두 이해되도록 작성된다 — 나중에 GPT에 그대로 전달해 우선순위 정리를 맡길 수 있다

공통: `[+ Feedback]` 폼(Type/Priority/내용/원하는 동작), 현재 작업 Context 자동 첨부,
markdown 파일이 SSOT (index.json 없음).

## Privacy / Local-first

- 네트워크 통신 없음. 계정 없음. telemetry 없음.
- 모든 데이터는 사용자가 지정한 로컬 폴더에 Markdown/JSON으로만 저장된다.
- ChatGPT 전달도 OS 파일 드래그일 뿐 — 앱이 대신 전송하거나 DOM을 조작하지 않는다.
- 설정 파일(`settings.json`)은 exe 옆에 생성되어 포터블하게 이동한다.
  (exe 폴더에 쓸 수 없는 경우에만 `%APPDATA%\agent-relay-log\AgentRelayLog`로 폴백)
