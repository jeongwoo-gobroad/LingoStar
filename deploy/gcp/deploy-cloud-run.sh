#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID}"
: "${REGION:=asia-northeast3}"
: "${SERVICE:=lingostar}"
: "${OPENAI_SECRET:=openai-api-key:latest}"
: "${STATE_STORE:=firestore}"
: "${FIRESTORE_PROJECT_ID:=${PROJECT_ID}}"
: "${FIRESTORE_DATABASE_ID:=(default)}"
: "${FIRESTORE_COLLECTION:=lingostar_states}"
: "${IS_AI_FALLBACK:=true}"
: "${AUTH_REQUIRED:=0}"
: "${OAUTH_ISSUER:=}"
: "${OAUTH_AUTHORIZATION_SERVERS:=${OAUTH_ISSUER}}"
: "${OAUTH_JWKS_URL:=}"
: "${OAUTH_SCOPES:=lingostar.read lingostar.write lingostar.audio}"
: "${OAUTH_REQUEST_SCOPES:=lingostar.read lingostar.write lingostar.audio}"
: "${OAUTH_CLIENT_ID:=}"
: "${OAUTH_ALLOW_SCOPELESS_TOKENS:=false}"
: "${FEEDBACK_ID_SECRET:=feedback-id:latest}"
: "${FEEDBACK_PW_SECRET:=feedback-pw:latest}"

APP_ORIGIN_PROVIDED="${APP_ORIGIN:-}"
APP_ORIGIN="${APP_ORIGIN_PROVIDED:-https://placeholder.invalid}"
: "${CORS_ALLOWED_ORIGINS:=${APP_ORIGIN},https://chatgpt.com}"
: "${WIDGET_CONNECT_DOMAINS:=${APP_ORIGIN}}"
: "${WIDGET_RESOURCE_DOMAINS:=${APP_ORIGIN}}"
: "${OAUTH_AUDIENCE:=${APP_ORIGIN}}"

gcloud config set project "${PROJECT_ID}"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com firestore.googleapis.com

deploy_service() {
  local env_vars
  env_vars="^##^APP_ORIGIN=${APP_ORIGIN}##CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS}##WIDGET_CONNECT_DOMAINS=${WIDGET_CONNECT_DOMAINS}##WIDGET_RESOURCE_DOMAINS=${WIDGET_RESOURCE_DOMAINS}##IS_AI_FALLBACK=${IS_AI_FALLBACK}##LINGOSTAR_STATE_STORE=${STATE_STORE}##FIRESTORE_PROJECT_ID=${FIRESTORE_PROJECT_ID}##FIRESTORE_DATABASE_ID=${FIRESTORE_DATABASE_ID}##FIRESTORE_COLLECTION=${FIRESTORE_COLLECTION}##LINGOSTAR_AUTH_REQUIRED=${AUTH_REQUIRED}##OAUTH_ISSUER=${OAUTH_ISSUER}##OAUTH_AUTHORIZATION_SERVERS=${OAUTH_AUTHORIZATION_SERVERS}##OAUTH_JWKS_URL=${OAUTH_JWKS_URL}##OAUTH_AUDIENCE=${OAUTH_AUDIENCE}##OAUTH_SCOPES=${OAUTH_SCOPES}##OAUTH_REQUEST_SCOPES=${OAUTH_REQUEST_SCOPES}##OAUTH_CLIENT_ID=${OAUTH_CLIENT_ID}##OAUTH_ALLOW_SCOPELESS_TOKENS=${OAUTH_ALLOW_SCOPELESS_TOKENS}##OAUTH_RESOURCE_DOCUMENTATION=${APP_ORIGIN}/privacy-poilcy.html"
  gcloud run deploy "${SERVICE}" \
    --source . \
    --region "${REGION}" \
    --allow-unauthenticated \
    --port 8080 \
    --memory 512Mi \
    --cpu 1 \
    --timeout 300 \
    --set-env-vars "${env_vars}" \
    --set-secrets "OPENAI_API_KEY=${OPENAI_SECRET},FEEDBACK_ADMIN_ID=${FEEDBACK_ID_SECRET},FEEDBACK_ADMIN_PASSWORD=${FEEDBACK_PW_SECRET}"
}

deploy_service

SERVICE_URL="$(gcloud run services describe "${SERVICE}" --region "${REGION}" --format 'value(status.url)')"

if [[ -z "${APP_ORIGIN_PROVIDED}" ]]; then
  APP_ORIGIN="${SERVICE_URL}"
  CORS_ALLOWED_ORIGINS="${SERVICE_URL},https://chatgpt.com"
  WIDGET_CONNECT_DOMAINS="${SERVICE_URL}"
  WIDGET_RESOURCE_DOMAINS="${SERVICE_URL}"
  OAUTH_AUDIENCE="${SERVICE_URL}"
  deploy_service
fi

echo "${SERVICE_URL}"
