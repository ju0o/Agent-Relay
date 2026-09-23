# Agent Relay

> GPT → 코딩 에이전트 작업을 **Prompt/Result Markdown 쌍**으로 기록하는 로컬 도구.
> DB 없음 · 클라우드 없음 · 파일시스템이 곧 데이터베이스.

Windows용 Electron 앱. Claude Code, Codex, OpenCode 등 에이전트에게 전달한 프롬프트와
그 결과를 날짜/에이전트/런(run) 단위로 자동 정리해준다.

## 설치 (권장 방식)

1. [Releases](https://github.com/ju0o/Agent-Relay/releases) 페이지에서 최신 `AgentRelay-Setup-x.y.z.exe` 다운로드
2. 실행하면 자동으로 설치된다 — 설치 경로 선택 등 별도 과정 없음
   (프로그램 본체: `%LOCALAPPDATA%\Programs\Agent Relay\`)
3. 설치 직후 앱이 바로 실행되며, 이후에는 아래에서 실행
   - 바탕화면 **Agent Relay** 바로가기
   - 시작 메뉴 **Agent Relay**
   - Windows 설정 > 설치된 앱 > **Agent Relay** (제거는 여기서)
4. 최초 1회만 데이터 폴더(DATA_ROOT) 선택 — 이후 앱이 자동 복원
5. 새 버전은 앱 안에서 업데이트 (⚙ 설정 → About → [업데이트 확인])

프로그램 본체와 사용자 데이터는 완전히 분리되어 있다. 제거/업데이트해도
DATA_ROOT의 기록과 설정은 절대 삭제되지 않는다.

Portable 버전(`AgentRelay-Portable-x.y.z.exe`)은 설치 없이 바로 실행하는 보조 배포판이다.
설정 파일을 exe 옆에 두므로 USB 휴대에 적합하다.

> ⚠️ Code signing 인증서가 없으므로 최초 설치 시 Windows SmartScreen 경고가 표시될 수 있다.
> "추가 정보 → 실행"으로 진행하면 된다.

## 현재 기능 (v0.3.0)

- **Windows 설치형(NSIS)** — 시작 메뉴/바탕화면 등록, 프로그램 추가/제거 지원
- **앱 내부 업데이트** — GitHub Release 기반, 사용자 클릭으로 다운로드/설치
- **영구 저장 설정** — DATA_ROOT·마지막 프로젝트·탭/에이전트 순서 저장,
  포터블 시절 settings.json은 최초 실행 시 조용히 이관(비파괴 복사)
- **Drag Reorder** — 프로젝트 탭·작업 탭·에이전트 목록을 드래그로 재배치
  (프로젝트/에이전트 순서는 영구 저장, 실제 폴더는 불변)
- **Quick Dogfooding 📝** — `[＋ 피드백]` 한 줄 입력 즉시 기록
  (기본값 Type=UX · Priority=MEDIUM · Status=OPEN, Context 자동 첨부)
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

단축키: `Ctrl+S` 모두 저장 · `Ctrl+N` 새 런 · `Ctrl+T` 새 탭 · `F12` DevTools

## 업데이트

앱은 GitHub Releases를 업데이트 피드로 사용한다(electron-updater · GitHub provider).

- 실행 후 조용히 1회 확인 — 새 버전이 있으면 작은 알림만 뜬다 (**자동 설치 없음**)
- ⚙ 설정 → About → [업데이트 확인] → 최신이면 "현재 최신 버전입니다"
- 새 버전이 있으면 [다운로드 및 업데이트] → 진행률 → [재시작하여 설치]
- 업데이트해도 DATA_ROOT의 기록·설정은 절대 삭제되지 않는다

참고: 저장소가 **private**인 동안은 GitHub Release를 인증 없이 읽을 수 없어
앱 내부 업데이트 확인이 실패한다(토큰은 앱에 넣지 않는다). 공개 전환 후 바로 동작한다.
접근 권한이 있는 환경에서는 환경변수 `AGENT_RELAY_GH_TOKEN`으로 확인할 수 있다
(머신별 opt-in일 뿐, 바이너리에 포함되지 않는다).

## 데이터 저장 구조

파일시스템 자체가 SSOT다. 모든 기록은 사용자가 지정한 DATA_ROOT 아래에 쌓인다.

```text
DATA_ROOT/                          ← 최초 1회 선택 (settings.json에 저장)
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
- 최초 1회 선택 후 저장되며 매 실행 자동 복원된다. 다시 묻지 않는다.
- 경로가 사라지면(외장 드라이브 제거 등) "저장공간을 찾을 수 없습니다" 화면이 뜨고 새 위치만 다시 선택하면 된다.
- 변경은 ⚙ 설정 → Storage 에서만 ([변경] / [폴더 열기]).
- 설정 파일 위치:
  - 설치형/Portable 공통: `%APPDATA%\agent-relay-log\settings.json` (Electron userData)
  - Portable은 exe 옆에 `settings.json`이 있으면 우선 사용 (USB 휴대용)
  - ~v0.2.x 포터블 폴백 위치(`%APPDATA%\agent-relay-log\AgentRelayLog`)의 설정은
    최초 실행 시 자동 **복사** 이관된다(원본 유지, 비파괴).

## Dogfooding 🐾

두 종류가 있으며 **데이터가 절대 섞이지 않는다**.

### Quick Capture (빠른 기록) — v0.3 신규

- 프로젝트 선택 중 상단 `[＋ 피드백]` 클릭 → 작은 Popover에서 한 줄 입력 → Enter 또는 [저장]
- 기본값 Type=UX / Priority=MEDIUM / Status=OPEN으로 즉시 저장 — 매번 폼을 채우지 않는다
- [상세 옵션]을 펼치면 Type/Priority/기대한 동작 수정 가능
- Project/Date/Agent/Run Context는 현재 화면 상태에서 자동 첨부
- 저장 위치: 현재 프로젝트 `{project}/_dogfooding/DF-NNNN.md`
- 10초 안에 기록 끝. 관리(모아보기/상태 변경)는 아래 Project Dogfooding 화면에서

### App Dogfooding (앱 자체 개선)

Agent Relay 프로그램 자체를 쓰면서 발견한 Bug/UX/Improvement 기록.

- 상단 `🐾 App Dogfooding` 버튼
- 저장: `DATA_ROOT/.agent-relay/dogfooding/DF-NNNN.md`
- Type: Bug / UX·불편 / Improvement / Good / Other

### Project Dogfooding (프로젝트 사용성 관리)

Quick Capture로 찍힌 기록을 포함해 프로젝트별 피드백을 모아보고 상태를 관리한다.

- 프로젝트 선택 후 상단 `📋 Project Dogfooding` 버튼 (프로젝트 미선택 시 비활성)
- 저장: `DATA_ROOT/{project}/_dogfooding/DF-NNNN.md` — **프로젝트마다 독립적인 ID 체계**
- Type: Bug / UX·Friction / Improvement / Idea / Good / Other
- Status 클릭 순환 변경: `OPEN → FIXED → HOLD`, 필터 ALL/OPEN/FIXED/HOLD, 상태별 개수 표시
- 행의 ▸ 클릭으로 전체 내용 보기, `[복사]`(md 전문) / `[파일 열기]`(탐색기 reveal)
- markdown 하나만 읽어도 어느 프로젝트의, 어떤 상황에서 발견한, 어떤 심각도의, 지금 어떤 상태인지
  기록이 모두 이해되도록 작성된다 — 나중에 GPT에 그대로 전달해 우선순위 정리를 맡길 수 있다

공통: markdown 파일이 SSOT (index.json 없음), 현재 작업 Context 자동 첨부.

## Release 자동화 (GitHub Actions)

태그를 push하면 Windows 빌드 → 테스트 → Release 업로드가 자동 실행된다.

```bash
git tag v0.3.1
git push origin v0.3.1
# → AgentRelay-Setup-0.3.1.exe / AgentRelay-Portable-0.3.1.exe
#   latest.yml / blockmap이 GitHub Release에 게시됨
```

## 처음 쓰는 법

처음 클론한 뒤 오프라인 E2E 흐름을 그대로 재현한다. 한 줄 실행이 전체 검증이다.

```bash
bash scripts/e2e.sh
```

위 스크립트(`scripts/e2e.sh`)가 순서대로 실행하는 명령은 아래와 정확히 같다.

```bash
npm run build:server
npm run build:client
npm run test:v2:runner
npm run typecheck
```

각 단계는 오프라인·임시 디렉터리 격리 상태로 실행된다.
`scripts/e2e.sh`가 하는 일은 다음과 같다.

- `E2E_TMP="$(mktemp -d "${TMPDIR:-/tmp}/agent-relay-e2e-XXXXXX")"`로
  임시 디렉터리를 만들고, `mkdir -p "$E2E_TMP/data"`로 격리된 데이터 폴더를 둔다.
- 각 단계마다 `npm_config_offline=true AGENT_RELAY_DATA_ROOT="$E2E_TMP/data"`
  환경으로 실행한다. 실제 `DATA_ROOT`의 기록에는 손대지 않는다.
- 단계별 로그는 `$E2E_TMP/<단계>.log`(예: `build_server.log`)에만 쓰고,
  stdout에는 마지막 한 줄의 JSON(`{"ok":bool,"steps":[{name,ok}],"ms":num}`)만 출력한다.
  진행 상황은 stderr로만 나온다.
- 종료 시 `trap 'rm -rf "$E2E_TMP"' EXIT`로 임시 디렉터리 전체를 지운다.

수동으로 같은 흐름을 재현하려면 임시 폴더를 직접 만들고 같은 env를 붙이면 된다.

```bash
E2E_TMP="$(mktemp -d "${TMPDIR:-/tmp}/agent-relay-e2e-XXXXXX")"
mkdir -p "$E2E_TMP/data"
npm_config_offline=true AGENT_RELAY_DATA_ROOT="$E2E_TMP/data" npm run build:server
npm_config_offline=true AGENT_RELAY_DATA_ROOT="$E2E_TMP/data" npm run build:client
npm_config_offline=true AGENT_RELAY_DATA_ROOT="$E2E_TMP/data" npm run test:v2:runner
npm_config_offline=true AGENT_RELAY_DATA_ROOT="$E2E_TMP/data" npm run typecheck
rm -rf "$E2E_TMP"
```

## 개발 (Development)

일반 사용자는 위 "설치" 섹션만 필요하다. 소스에서 직접 빌드할 때만 사용한다.

```bash
npm install

# client(vite) + server(tsc) 빌드 후 electron 실행
npm run dev

# 타입 체크
npm run typecheck

# 테스트 (fs 레이어 + vnext 회귀 + v0.3 기능)
npm test

# Windows 패키징 (NSIS Setup + Portable → dist/)
npm run build:win
# 또는 로그 래퍼: node scripts/build-win.mjs  (→ dist/buildwin.log)
```

## Privacy / Local-first

- 계정 없음. telemetry 없음.
- 모든 데이터는 사용자가 지정한 로컬 폴더에 Markdown/JSON으로만 저장된다.
- ChatGPT 전달도 OS 파일 드래그일 뿐 — 앱이 대신 전송하거나 DOM을 조작하지 않는다.
- 네트워크 통신은 업데이트 확인 시 GitHub Releases 조회(읽기)뿐이다. 기록 데이터는 전송되지 않는다.


