#!/usr/bin/env bash
# generate-keys.sh — Generate RS256 key pair for local development
# In production, keys should be managed via GCP Secret Manager.
set -euo pipefail

KEYS_DIR="$(cd "$(dirname "$0")/.." && pwd)/keys"

if [ -f "$KEYS_DIR/private.pem" ]; then
  echo "Keys already exist at $KEYS_DIR — delete them manually to regenerate."
  exit 0
fi

echo "Generating RS256 (2048-bit) key pair in $KEYS_DIR ..."

# Generate private key in PKCS#8 format (required by jose/importPKCS8)
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$KEYS_DIR/private.pem" 2>/dev/null

# Extract public key in SPKI format (required by jose/importSPKI)
openssl pkey -pubout -in "$KEYS_DIR/private.pem" -out "$KEYS_DIR/public.pem"

echo "Keys generated:"
echo "  Private: $KEYS_DIR/private.pem"
echo "  Public:  $KEYS_DIR/public.pem"
echo ""
echo "These files are in .gitignore and must NEVER be committed."
echo ""
echo "To use in Cloud Run, encode them as base64 and store in Secret Manager:"
echo "  base64 -i keys/private.pem | tr -d '\\n'  →  JWT_PRIVATE_KEY_B64"
echo "  base64 -i keys/public.pem  | tr -d '\\n'  →  JWT_PUBLIC_KEY_B64"
