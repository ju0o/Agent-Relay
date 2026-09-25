# 개발자 문서

일반 사용자는 [README](../README.md)만 보면 된다. 소스에서 직접 빌드할 때 참고한다.

## 빌드 · 실행 · 테스트

```bash
npm install
npm run dev          # client(vite) + server(tsc) 빌드 후 electron 실행 (watch/HMR 없음)
npm run typecheck
npm test             # fs · vnext · v0.3 · v2(runner · night · founder) — pretest가 서버 빌드
npm run build:win    # Windows 패키징 → dist/ (Setup + Portable)
```

`--view=` 로 시작 화면을 바꿀 수 있다: `home | control-room | approvals | plan-studio`
(잘못된 값은 관제실).

## 오프라인 E2E

```bash
bash scripts/e2e.sh
```

임시 폴더에 격리해 `build:server` → `build:client` → `test:v2:runner` → `typecheck`를 실행하고,
마지막 한 줄 JSON(`{"ok":bool,"steps":[...],"ms":num}`)만 stdout에 낸다. 종료 시 임시 폴더를 지운다.

## CLI (`bridge/agent-relay.mjs`)

```bash
node bridge/agent-relay.mjs core-v1 status|results [--json]|start|resume
node bridge/agent-relay.mjs night-run once|up [--deadline HH:MM] [--no-poweroff]|status|stop|shutdown
node bridge/agent-relay.mjs portfolio status|reconcile|intake|pm-intake|result|result-return|founder-response|up|stop
node bridge/agent-relay.mjs project run|retry|status <projectId>
```

`AGENT_RELAY_DATA_ROOT` 로 러너 상태 폴더를, `AGENT_RELAY_PORTFOLIO_MANIFEST` 로 매니페스트를 바꾼다.
Night Run 운영 절차: [CORE_V1_AUTO_NIGHT_RUN.md](CORE_V1_AUTO_NIGHT_RUN.md)

## 업데이트 · 릴리스

- 앱은 GitHub Releases를 업데이트 피드로 쓴다(electron-updater). 실행 후 조용히 1회 확인하고
  자동 설치는 하지 않는다. ⚙ 설정 → About → [업데이트 확인].
- 저장소가 private이면 인증 없이 Release를 읽을 수 없어 확인이 실패한다.
  접근 권한이 있는 PC는 환경변수 `AGENT_RELAY_GH_TOKEN`으로 확인할 수 있다(바이너리에는 안 들어간다).
- `v*` 태그를 push하면 GitHub Actions가 Windows 빌드 → 테스트 → Release 업로드를 실행한다.
- 코드 서명 인증서가 없어 첫 설치 때 SmartScreen 경고가 뜰 수 있다("추가 정보 → 실행").
