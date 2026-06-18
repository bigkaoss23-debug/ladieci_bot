#!/usr/bin/env bash
# ===============================================================
# deploy.sh — UNICO comando di deploy. Va SOLO sullo staging V1.
# La produzione (ladieci_bot) NON ha un comando: si tocca solo a mano,
# consapevolmente, alla fine. Qui è impossibile finirci per sbaglio.
# Uso:  npm run deploy
# ===============================================================
set -euo pipefail

SERVICE="fearless-reverence"        # bersaglio FISSO: staging V1
COMMIT="$(git rev-parse --short HEAD)"

echo ""
echo "  >>> DEPLOY → STAGING ($SERVICE)  —  commit $COMMIT"
echo ""

# Aggancia il CLI allo staging e leggi l'URL reale del bersaglio.
railway service "$SERVICE" >/dev/null 2>&1 || true
URL="$(railway status 2>/dev/null | grep -i 'url:' | head -1)"

# UNICA riga di sicurezza: se il bersaglio NON è lo staging, fermati.
case "$URL" in
  *fearless-reverence*) : ;;                                   # ok, è staging
  *) echo "  STOP: bersaglio non è lo staging ($URL). Deploy annullato." ; exit 1 ;;
esac

# Conferma solo se lanciato a mano in un terminale (non blocca l'automazione).
if [ -t 0 ]; then
  read -r -p "  Confermi il deploy su STAGING? [y/N] " ans
  [ "$ans" = "y" ] || { echo "  Annullato." ; exit 0 ; }
fi

railway up --service "$SERVICE" --ci
echo ""
echo "  >>> Fatto. Live: https://fearless-reverence-production-80bc.up.railway.app"
