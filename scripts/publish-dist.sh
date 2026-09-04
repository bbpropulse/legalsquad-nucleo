#!/usr/bin/env bash
# Publishes the PUBLIC distribution repo from this PRIVATE dev repo.
# Builds the npm-distributable tree (files[] only — no dev history, no tests,
# no commercial staging, nothing gitignored) and force-pushes it as a single
# snapshot commit to the public dist repo. Re-run on each release.
#
# Requires: gh (authenticated), node, git.
# Usage:   bash scripts/publish-dist.sh [owner/repo]
set -euo pipefail

REPO="${1:-bbpropulse/legalsquad-nucleo}"
VERSION="$(node -p "require('./package.json').version")"
OUT="$(mktemp -d)/legalsquad-dist"

echo "==> Construindo a árvore de distribuição (v${VERSION})…"
node scripts/build-dist.mjs "$OUT"

cd "$OUT"
git init -q
# Pin the author so the snapshot never inherits a stray global git identity.
git config user.name "${DIST_AUTHOR_NAME:-Criminal Lab}"
git config user.email "${DIST_AUTHOR_EMAIL:-propulseglobal@gmail.com}"
git add -A
git commit -q -m "dist: legalsquad v${VERSION}"
git branch -M main

if gh repo view "$REPO" >/dev/null 2>&1; then
  echo "==> Repo ${REPO} já existe — atualizando (snapshot)…"
  git remote add origin "https://github.com/${REPO}.git"
  git push -u origin main --force
else
  echo "==> Criando repo PÚBLICO ${REPO} e publicando…"
  gh repo create "$REPO" --public --source=. --remote=origin --push \
    --description "LegalSquad — distribuição pública (instalação/atualização do Núcleo de Prática Criminal)"
fi

echo
echo "Publicado: https://github.com/${REPO}"
echo "Aluno instala:  npm i -g github:${REPO} && legalsquad init"
echo "Aluno atualiza: npm i -g github:${REPO} && legalsquad update"
