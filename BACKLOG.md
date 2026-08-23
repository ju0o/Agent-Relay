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

## 완료된 것 (v0.2.0)

- [x] Claude Code 등 에이전트 폴더가 앱 탐색만으로 선생성되던 문제 → 저장 시점 생성으로 변경
- [x] DATA_ROOT 매 실행 선택/유실 문제 → settings.json 자동 복원 + 유실 안내 화면
- [x] 마지막 프로젝트 자동 복원
- [x] Result → ChatGPT 1-제스처 전달 (native drag-out) + Explorer reveal fallback
- [x] Dogfooding 기록 기능
