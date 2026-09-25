# 기록 저장 · 피드백(Dogfooding) 상세

Agent Relay 앱의 "기록" 화면(프롬프트/결과 Markdown 정리)과 피드백 기능의 상세 설명이다.
처음 쓰는 분은 [README](../README.md)만 보면 충분하다.

## 처음 실행하면

처음 실행하면 "데이터 폴더를 먼저 선택하세요" 화면이 뜬다.

- **[기본 폴더 사용 (문서 › Agent Relay)]** — 클릭 한 번으로 시작
- **[다른 폴더 고르기]** — 외장 드라이브/동기화 폴더 등 원하는 위치 선택

최초 1회만 고르면 이후 앱이 자동 복원한다. 경로가 사라지면(외장 드라이브 제거 등)
안내 화면이 뜨고 새 위치만 다시 고르면 된다.

## 데이터 저장 구조

파일시스템 자체가 SSOT다(DB 없음). 모든 기록은 DATA_ROOT 아래에 쌓인다.

```text
DATA_ROOT/                          ← 최초 1회 선택 (settings.json에 저장)
├─ {project}/
│  ├─ YYYY-MM-DD/
│  │  └─ {agent}/                   ← 예: "Claude Code", "OpenCode"
│  │     ├─ 01/
│  │     │  ├─ prompt.md            ← 에이전트에게 준 프롬프트
│  │     │  ├─ result.md            ← 에이전트의 결과 보고
│  │     │  └─ meta.json            ← {"tags": [...]}
│  │     └─ 02/
│  └─ _dogfooding/                  ← 이 프로젝트의 사용성 피드백
│     └─ DF-0001.md
└─ .agent-relay/                    ← 앱 내부 데이터 (프로젝트 목록에 안 나타남)
   └─ dogfooding/DF-NNNN.md         ← Agent Relay 앱 자체 피드백
```

- 특수 프로젝트 `'.'`: `DATA_ROOT/{date}/{agent}/{NN}` 구조
- 런 폴더는 **실제 저장 시점에만** 생성된다. 번호는 재사용하지 않는다.
- DATA_ROOT 변경은 ⚙ 설정 → Storage ([변경] / [폴더 열기]).
- 설정 파일: `%APPDATA%\agent-relay-log\settings.json` (Electron userData).
  Portable은 exe 옆 `settings.json`이 있으면 우선 사용한다.

## 기록 화면 기능

- 프로젝트 세션 탭 · 병렬 편집 탭(`Ctrl+T`) · 새 런(`Ctrl+N`) · 모두 저장(`Ctrl+S`)
- Prompt/Result 저장 — 덮어쓰기 금지가 기본, 확인 후 허용
- 태그(성공/진행중/검토/실패/참고), 마크다운 미리보기, 파일 트리(검색·드래그 이동)
- 프로젝트 탭·작업 탭·에이전트 목록 드래그 재배치(순서는 영구 저장)
- Result 전달: `GPT로 드래그` 칩(OS 파일 드래그) · `위치 열기` · `.md 내보내기`
- 앱이 대신 전송하거나 웹 화면을 조작하지 않는다.

## Dogfooding (피드백 기록)

두 종류이며 데이터는 섞이지 않는다.

- **Quick Capture** — 상단 `[＋ 피드백]` → 한 줄 입력 → Enter. 기본값 Type=UX · Priority=MEDIUM ·
  Status=OPEN, 현재 화면 Context 자동 첨부. 저장: `{project}/_dogfooding/DF-NNNN.md`
- **App Dogfooding** — 앱 자체 개선 기록. 저장: `DATA_ROOT/.agent-relay/dogfooding/DF-NNNN.md`
- **Project Dogfooding** — 프로젝트별 피드백 모아보기. 프로젝트마다 독립 ID.
  Status 클릭으로 `OPEN → FIXED → HOLD` 순환, 검색·Type 필터, `[복사]` / `[파일 열기]`.

markdown 파일이 SSOT다(index.json 없음).

## Privacy

계정 없음 · telemetry 없음. 데이터는 로컬 폴더에 Markdown/JSON으로만 저장된다.
네트워크는 업데이트 확인 시 GitHub Releases 조회(읽기)뿐이다.
