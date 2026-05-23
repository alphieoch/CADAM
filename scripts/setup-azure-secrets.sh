#!/bin/bash
# Setup script for Azure Container App secrets
# Run this script with your actual secret values to configure the CADAM app on Azure

set -e

RESOURCE_GROUP="rg-cadam"
CONTAINER_APP="cadam-app-y4j7ueua3263k"

echo "=========================================="
echo "CADAM Azure Secret Setup"
echo "=========================================="
echo ""

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

if ! command_exists az; then
    echo "Error: Azure CLI (az) is not installed."
    echo "Please install it from: https://docs.microsoft.com/en-us/cli/azure/install-azure-cli"
    exit 1
fi

# Check if user is logged in
az account show >/dev/null 2>&1 || {
    echo "Error: Not logged into Azure. Please run 'az login' first."
    exit 1
}

echo "Setting basic environment variables..."
az containerapp update \
  --name "$CONTAINER_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --set-env-vars \
    "NODE_ENV=production" \
    "ENVIRONMENT=production" \
    "NITRO_PORT=3000" \
    "WEBHOOK_BASE_URL=https://cadam-app-y4j7ueua3263k.thankfulrock-fe738ee3.uksouth.azurecontainerapps.io/cadam"

echo ""
echo "=========================================="
echo "SECRET CONFIGURATION"
echo "=========================================="
echo ""
echo "The app requires the following secrets to function."
echo "You will be prompted for each one. Press Enter to skip a secret."
echo ""

# Array of secrets: "env_var_name|secret_name|description"
declare -a secrets=(
    "VITE_SUPABASE_URL|vite-supabase-url|Supabase project URL (e.g., https://your-project.supabase.co)"
    "VITE_SUPABASE_ANON_KEY|vite-supabase-anon-key|Supabase anonymous/public API key"
    "SUPABASE_SERVICE_ROLE_KEY|supabase-service-role-key|Supabase service role key (keep secret!)"
    "ANTHROPIC_API_KEY|anthropic-api-key|Anthropic API key for Claude models"
    "OPENROUTER_API_KEY|openrouter-api-key|OpenRouter API key (required for DeepSeek Flash)"
    "OPENAI_API_KEY|openai-api-key|OpenAI API key for GPT models"
    "GOOGLE_API_KEY|google-api-key|Google API key for Gemini models"
    "FAL_KEY|fal-key|FAL API key for image generation"
    "BILLING_SERVICE_URL|billing-service-url|Billing service URL"
    "BILLING_SERVICE_KEY|billing-service-key|Billing service API key"
    "ADAM_URL|adam-url|Adam URL or dev URL"
    "NGROK_URL|ngrok-url|NGROK URL (for local dev webhooks, optional)"
    "VITE_POSTHOG_PROJECT_KEY|vite-posthog-project-key|PostHog project key (optional)"
    "VITE_SENTRY_DSN|vite-sentry-dsn|Sentry DSN (optional)"
)

secret_args=""
env_args=""

for secret_info in "${secrets[@]}"; do
    IFS='|' read -r env_name secret_name description <<< "$secret_info"

    echo -n "Enter $description [$env_name]: "
    read -s value
    echo ""

    if [ -n "$value" ]; then
        secret_args="$secret_args \"$secret_name=$value\""
        env_args="$env_args \"$env_name=secretref:$secret_name\""
    fi
done

if [ -n "$secret_args" ]; then
    echo ""
    echo "Setting secrets in Azure Container Apps..."
    eval az containerapp secret set \
      --name "$CONTAINER_APP" \
      --resource-group "$RESOURCE_GROUP" \
      --secrets $secret_args

    echo ""
    echo "Mapping secrets to environment variables..."
    eval az containerapp update \
      --name "$CONTAINER_APP" \
      --resource-group "$RESOURCE_GROUP" \
      --set-env-vars $env_args
fi

echo ""
echo "=========================================="
echo "SETUP COMPLETE"
echo "=========================================="
echo ""
echo "Your CADAM app is deployed at:"
echo "https://cadam-app-y4j7ueua3263k.thankfulrock-fe738ee3.uksouth.azurecontainerapps.io/cadam"
echo ""
echo "Health check: https://cadam-app-y4j7ueua3263k.thankfulrock-fe738ee3.uksouth.azurecontainerapps.io/cadam/health"
echo ""
echo "To view logs, run:"
echo "  az containerapp logs show --name $CONTAINER_APP --resource-group $RESOURCE_GROUP --follow"
echo ""
