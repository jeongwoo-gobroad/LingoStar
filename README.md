# LingoStar

---

- (c) 2026 Jeongwoo Kim

LingoStar는 ChatGPT Apps용 외국어 학습 MCP 앱입니다. ChatGPT가 학습 계획, 문제 생성, 말하기 평가, 목표 달성 판단을 수행하고, MCP 서버는 구조화된 도구, GUI 상태, 검증, 음성 폴백, OAuth, 영속 상태 저장을 담당합니다.

## 주요 파일

- MCP 서버: [server.js](./server.js)
- ChatGPT iframe 위젯: [public/lingostar-widget.html](./public/lingostar-widget.html)
- GCP/Cloud Run 배포 문서: [docs/deployment-gcp.md](./docs/deployment-gcp.md)
- ChatGPT Apps 제출 JSON: [chatgpt-app-submission.json](./chatgpt-app-submission.json)
- 개인정보 처리방침: [privacy-poilcy.html](./privacy-poilcy.html)
- 이용약관: [terms-of-service.html](./terms-of-service.html)

## 학습 섹션 구조

섹션의 문제 수는 총합 n개가 아니라 영역별 n개입니다. 현재 영역은 `language_info`, `listening`, `reading`, `writing`, `speaking`입니다.

- `language_info`: 언어별 문자, 발음, 문법/표기 특성 등을 다지선다로 학습합니다.
- `listening`: 브라우저 TTS 우선, 서버 OpenAI TTS 폴백입니다.
- `reading`/`writing`: 객관식 및 토큰 재배열은 즉시 채점됩니다.
- `speaking`: 브라우저 STT 우선, 필요 시 서버 OpenAI STT 폴백이며 섹션 완료 시 ChatGPT가 평가합니다.

기본 문제 수는 영역별 3개이며, 설정 화면에서 영역별 3-6개로 조정할 수 있습니다.

## 상태 저장

로컬 단일 프로세스 개발은 `LINGOSTAR_STATE_STORE=memory`를 사용할 수 있습니다. Cloud Run 배포는 서버리스 특성상 `LINGOSTAR_STATE_STORE=firestore`를 권장합니다.

저장되는 논리 컨텍스트:

- User Agent: ChatGPT/OAuth 기반 유저 키
- Language Selection: 유저별 학습 언어와 목표
- Tracking Agent: 언어별 진행 상황 자연어 컨텍스트
- Problem Management Agent: 언어별 취약점 자연어 컨텍스트

`--developer-mode` 또는 `LINGOSTAR_DEVELOPER_MODE=1`에서는 모든 요청이 `developer-mode:local-demo-user` 더미 키를 사용합니다.

## 음성 기능

브라우저 내장 기능을 비용 절감용 기본 경로로 사용합니다.

- TTS: `speechSynthesis` 우선, 실패 시 `synthesize_speech`
- STT: `SpeechRecognition` 우선, 실패/미지원 시 녹음 후 `transcribe_audio`
- `IS_AI_FALLBACK=false`이면 OpenAI 음성 폴백을 호출하지 않고 “브라우저 내 음성 기능 오류”만 표시합니다.

## 로컬 실행

```bash
npm install
npm run start
```

기본 MCP endpoint:

```text
http://localhost:8787/mcp
```

로컬 위젯 미리보기:

```text
http://localhost:8787/preview
```

## 검증

```bash
npm run check
npm run verify
npm run verify:auth
npm run verify:developer-mode
```

## 배포

Cloud Run, Firestore, OAuth, CSP, Secret Manager 설정은 [docs/deployment-gcp.md](./docs/deployment-gcp.md)를 따르세요.

주요 배포 파일:

- [Dockerfile](./Dockerfile)
- [.env.example](./.env.example)
- [deploy/gcp/deploy-cloud-run.ps1](./deploy/gcp/deploy-cloud-run.ps1)
- [deploy/gcp/deploy-cloud-run.sh](./deploy/gcp/deploy-cloud-run.sh)
- [deploy/gcp/cloudbuild.yaml](./deploy/gcp/cloudbuild.yaml)

## Operator Notes

- Widget resource URI is versioned in `server.js`; bump `WIDGET_VERSION` and the `ui://widget/...html` filename together when changing widget UI.
- `/feedback` shows submitted user feedback with sequential IDs. On Cloud Run, inject `FEEDBACK_ADMIN_ID` and `FEEDBACK_ADMIN_PASSWORD` from Secret Manager secrets `feedback-id` and `feedback-pw`.
- For Auth0 + ChatGPT Apps, use `OAUTH_SCOPE_MODE=none` if Auth0 authorization-code logs keep showing `scope: null`. LingoStar will still verify JWT signature, issuer, audience/resource, and the configured Auth0 client id when present. Use `OAUTH_SCOPE_MODE=strict` only when your provider reliably returns custom API scopes.
