# LingoStar GCP GUI 배포 및 장애 대응 가이드

이 문서는 게시된 LingoStar 앱에서 `Failed to fetch template` 같은 위젯 로딩 오류가 발생했을 때, Google Cloud Console GUI에서 무엇을 확인하고 어떻게 배포해야 하는지 설명합니다.

## 1. 현재 장애 해석

사진의 흐름은 다음과 같습니다.

1. ChatGPT가 `manage_learning_session` 도구를 호출했습니다.
2. 서버는 `{ state, initialView: "lesson" }` 응답을 정상 반환했습니다.
3. ChatGPT가 도구 descriptor의 UI template URI를 읽어 위젯을 띄우려 했습니다.
4. template fetch 단계에서 실패했습니다.

즉, 학습 트랙 저장 자체보다 **ChatGPT가 MCP resource template을 다시 가져오는 경로**가 문제입니다.

이번 코드 수정은 이 문제를 두 방향에서 완화합니다.

- 현재 위젯 URI `v0-10-2`뿐 아니라 직전 URI `v0-10-1`도 계속 등록합니다. 기존 대화, 게시 캐시, 오래된 tool descriptor가 예전 URI를 요청해도 `Resource not found`가 나지 않습니다.
- `/icon.png`, `/preview`, `/privacy-policy.html`, `/terms-of-service.html`, `/status.json` 같은 공개 경로가 `HEAD` 요청도 정상 처리합니다. 게시 플랫폼과 로더가 사전 확인 요청을 보내도 404가 나지 않게 합니다.

## 2. 배포 전 로컬 확인

저장소 루트에서 아래 명령을 모두 통과시킨 뒤 배포합니다.

```powershell
npm run check
npm run verify
npm run verify:auth
npm run verify:auth-scope-none
npm run verify:developer-mode
```

특히 `npm run verify`는 다음 항목을 확인해야 합니다.

- 현재 widget resource URI 3개를 읽을 수 있음
- 이전 `v0-10-1` widget resource URI 3개도 읽을 수 있음
- `/icon.png`의 `HEAD` 요청이 200을 반환함
- 말하기가 꺼진 practice set도 95점 이상 기준에서 정상 pass 가능함
- 현재 practice set에 없는 exerciseId 채점은 거절됨

## 3. Google Cloud Console에서 새 리비전 배포

1. Google Cloud Console에 접속합니다.
2. 상단 프로젝트 선택기에서 LingoStar 프로젝트를 선택합니다.
3. 왼쪽 메뉴에서 **Cloud Run**을 엽니다.
4. 서비스 목록에서 `lingostar`를 클릭합니다.
5. 상단의 **Edit & deploy new revision**을 클릭합니다.
6. **Container image URL**이 최신 빌드 이미지인지 확인합니다.
   - Cloud Build를 사용했다면 Artifact Registry의 최신 이미지 태그를 선택합니다.
   - `deploy/gcp/cloudbuild.yaml`로 빌드했다면 Cloud Build 완료 후 생성된 이미지가 자동 배포됩니다.
7. **Container port**가 `8080`인지 확인합니다.
8. HTTP/2 end-to-end, h2c, HTTP/2 container port 설정이 켜져 있지 않은지 확인합니다.
   - LingoStar 서버는 Node HTTP/1 서버입니다.
   - Cloud Run 컨테이너 포트가 h2c로 잡히면 `/mcp`에 도달하기 전에 upstream protocol 오류가 날 수 있습니다.
9. CPU는 `1`, Memory는 최소 `512MiB`, Timeout은 `300s`를 권장합니다.
10. **Deploy**를 누릅니다.

## 4. 환경 변수 확인

Cloud Run 서비스 화면에서 **Variables & Secrets** 섹션을 확인합니다.

필수 환경 변수:

```text
APP_ORIGIN=https://YOUR_RUN_APP_URL
CORS_ALLOWED_ORIGINS=https://YOUR_RUN_APP_URL,https://chatgpt.com
WIDGET_CONNECT_DOMAINS=https://YOUR_RUN_APP_URL
WIDGET_RESOURCE_DOMAINS=https://YOUR_RUN_APP_URL
LINGOSTAR_STATE_STORE=firestore
FIRESTORE_PROJECT_ID=YOUR_GCP_PROJECT
FIRESTORE_DATABASE_ID=(default)
FIRESTORE_COLLECTION=lingostar_states
LINGOSTAR_AUTH_REQUIRED=1
OAUTH_RESOURCE_DOCUMENTATION=https://YOUR_RUN_APP_URL/privacy-policy.html
```

OAuth 관련 값:

```text
OAUTH_ISSUER=https://YOUR_AUTH0_DOMAIN
OAUTH_AUTHORIZATION_SERVERS=https://YOUR_AUTH0_DOMAIN
OAUTH_JWKS_URL=https://YOUR_AUTH0_DOMAIN/.well-known/jwks.json
OAUTH_AUDIENCE=https://YOUR_RUN_APP_URL
OAUTH_SCOPES=lingostar.read lingostar.write lingostar.audio
OAUTH_REQUEST_SCOPES=lingostar.read lingostar.write lingostar.audio
OAUTH_CLIENT_ID=YOUR_AUTH0_OR_CHATGPT_APP_CLIENT_ID
OAUTH_SCOPE_MODE=none
OAUTH_VALIDATE_CLIENT_ID=true
OAUTH_ALLOW_SCOPELESS_TOKENS=false
```

음성 fallback:

```text
IS_AI_FALLBACK=false
```

`OPENAI_API_KEY` Secret이 있고 서버 STT/TTS fallback을 실제로 쓸 때만 `IS_AI_FALLBACK=true`로 바꿉니다.

## 5. Secret Manager 확인

Google Cloud Console에서 **Secret Manager**를 엽니다.

확인할 Secret:

- `openai-api-key`
- `feedback-id`
- `feedback-pw`

각 Secret에 enabled version이 있어야 합니다. Cloud Run의 **Variables & Secrets**에서 다음처럼 연결되어 있어야 합니다.

```text
OPENAI_API_KEY -> openai-api-key:latest
FEEDBACK_ADMIN_ID -> feedback-id:latest
FEEDBACK_ADMIN_PASSWORD -> feedback-pw:latest
```

`IS_AI_FALLBACK=false`이면 `OPENAI_API_KEY`는 앱 로딩에는 필요하지 않습니다. 하지만 Secret 연결이 깨져 있으면 리비전 시작 자체가 실패할 수 있으니, 연결을 유지할 경우 Secret version은 반드시 존재해야 합니다.

## 6. IAM 권한 확인

Cloud Run 서비스 상세 화면에서 **Security** 또는 **Details** 탭을 보고 runtime service account를 확인합니다.

Google Cloud Console의 **IAM & Admin > IAM**에서 해당 service account에 다음 역할이 있는지 확인합니다.

- Cloud Datastore User 또는 Datastore User
- Secret Manager Secret Accessor

Firestore를 쓰므로 Datastore 권한이 필요합니다. Secret을 환경 변수로 주입하므로 Secret Manager 접근 권한도 필요합니다.

Cloud Run 서비스 자체는 **Allow unauthenticated invocations**가 켜져 있어야 합니다. ChatGPT가 `/mcp`에 접근해야 하기 때문입니다. 최종 사용자 인증은 Cloud Run IAM이 아니라 LingoStar 서버의 OAuth/JWT 검증이 처리합니다.

## 7. Firestore GUI 확인

1. Google Cloud Console에서 **Firestore**를 엽니다.
2. Native mode database가 있는지 확인합니다.
3. Database ID가 `(default)`인지 확인합니다.
4. Cloud Run region과 가까운 위치를 사용합니다. 현재 권장은 `asia-northeast3`입니다.
5. 데이터 탭에서 `lingostar_states` 컬렉션이 생성되는지 확인합니다.

앱 사용 후 문서가 생성되지 않으면 다음을 의심합니다.

- `LINGOSTAR_STATE_STORE`가 `firestore`가 아님
- `FIRESTORE_PROJECT_ID`가 틀림
- Cloud Run service account에 Datastore 권한이 없음

## 8. 배포 후 브라우저 확인

Cloud Run 서비스 상세 화면의 URL을 엽니다. 아래 경로를 직접 확인합니다.

```text
https://YOUR_RUN_APP_URL/status.json
https://YOUR_RUN_APP_URL/icon.png
https://YOUR_RUN_APP_URL/preview
https://YOUR_RUN_APP_URL/privacy-policy.html
https://YOUR_RUN_APP_URL/privacy-poilcy.html
https://YOUR_RUN_APP_URL/terms-of-service.html
https://YOUR_RUN_APP_URL/.well-known/oauth-protected-resource
```

`status.json`에서 특히 확인할 값:

```json
{
  "ok": true,
  "version": "0.10.2",
  "widgetVersion": "0.10.2",
  "widgetUris": {
    "lesson": "ui://widget/lingostar-lesson-v0-10-2.html"
  },
  "legacyWidgetUris": {
    "lesson": ["ui://widget/lingostar-lesson-v0-10-1.html"]
  },
  "authRequired": true,
  "stateStore": "firestore",
  "firestoreConfigured": true,
  "oauthScopeMode": "none"
}
```

가능하면 Cloud Shell에서 HEAD도 확인합니다.

```bash
origin="https://YOUR_RUN_APP_URL"
curl -I "$origin/status.json"
curl -I "$origin/icon.png"
curl -I "$origin/preview"
curl -I "$origin/privacy-policy.html"
```

`icon.png`가 `HEAD`에서 404이면 이전 리비전이 아직 서비스 중이거나 새 코드가 배포되지 않은 것입니다.

## 9. ChatGPT 앱 쪽 확인

1. ChatGPT에서 새 대화를 엽니다.
2. LingoStar 앱을 선택합니다.
3. 다음과 같이 테스트합니다.

```text
JLPT N3를 준비하고 싶어요.
```

정상 동작:

- `manage_learning_session` 또는 `create_lesson_exercises` 도구 호출이 성공합니다.
- LingoStar lesson widget이 표시됩니다.
- `Failed to fetch template`가 나오지 않습니다.

오류가 계속되면 다음 순서로 확인합니다.

1. Cloud Run 최신 리비전이 100% traffic을 받고 있는지 확인합니다.
2. `/status.json`에 `legacyWidgetUris`가 표시되는지 확인합니다.
3. Cloud Run Logs에서 `Resource ... not found`를 검색합니다.
4. ChatGPT에서 앱 연결을 해제 후 다시 연결합니다.
5. 새 대화에서 다시 테스트합니다.

## 10. Cloud Run 로그에서 볼 것

Cloud Run 서비스 화면에서 **Logs** 탭을 엽니다.

검색어:

```text
Resource
not found
Error handling stateless MCP POST
Error handling MCP POST
AUTH_ERROR
Firestore
```

판단 기준:

- `Resource ui://widget/...v0-10-1.html not found`
  - 이전 URI alias가 없는 리비전입니다. 최신 리비전을 다시 배포합니다.
- `AUTH_ERROR Audience mismatch`
  - `OAUTH_AUDIENCE`와 Auth0 API Identifier 또는 token audience가 다릅니다.
- `AUTH_ERROR Client ID mismatch`
  - `OAUTH_CLIENT_ID`와 토큰의 `azp`, `client_id`, `cid`가 맞지 않습니다.
- `Firestore save failed`
  - service account 권한 또는 Firestore 설정 문제입니다.

## 11. 롤백 방법

1. Cloud Run 서비스 상세 화면에서 **Revisions** 탭을 엽니다.
2. 직전 정상 리비전을 선택합니다.
3. **Manage traffic**을 클릭합니다.
4. 직전 정상 리비전에 100% traffic을 배정합니다.
5. `status.json`과 ChatGPT 앱을 다시 테스트합니다.

이번 수정은 backward-compatible alias를 추가하는 방식이라 롤백 가능성이 낮지만, OAuth/Firestore 설정 변경과 함께 배포할 때는 항상 traffic 전환 상태를 확인합니다.

## 12. 다음 버전 배포 규칙

위젯 UI를 바꿔 `WIDGET_VERSION`을 올릴 때는 다음을 같이 지킵니다.

1. 새 URI를 `ui://widget/...-vX-Y-Z.html` 형식으로 등록합니다.
2. 직전 버전 URI는 최소 1개 버전 동안 alias로 유지합니다.
3. `npm run verify`에 legacy resource read 테스트를 유지합니다.
4. Cloud Run 배포 후 `/status.json`에서 `widgetUris`와 `legacyWidgetUris`를 확인합니다.
5. ChatGPT 기존 대화와 새 대화 모두에서 앱을 열어 봅니다.

이 규칙을 지키면 게시 앱 캐시와 기존 대화가 서로 다른 템플릿 URI를 들고 있어도 위젯 로딩 실패 가능성이 크게 줄어듭니다.
