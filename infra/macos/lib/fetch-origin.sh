# fetch-origin.sh - sourced by launchd jobs that run code from a PRIVATE repo's origin/main.
#
# A launchd job has no git credential, so an anonymous `git fetch` of a private repo fails with "Repository not
# found" and the job never runs (APP-283: play-vitals failed this way on its first scheduled run). fetch_origin
# tries anonymously first, then mints a short-lived App installation token scoped to that one repo (the same
# minter repo-refresh.sh uses) and retries once. The token reaches git through environment variables (never argv,
# so it is not visible in `ps`) and is never logged. FETCH_ORIGIN_TOKEN_CMD replaces the minter in tests.
#
#   fetch_origin <repo-dir>      # returns 0 when origin was fetched (anonymously or authenticated)
fetch_origin() {
  local dir="$1" name json tok b64
  git -C "$dir" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 fetch --quiet origin 2>/dev/null && return 0
  name="$(basename "$(git -C "$dir" remote get-url origin)" .git)"
  if [ -n "${FETCH_ORIGIN_TOKEN_CMD:-}" ]; then
    json="$($FETCH_ORIGIN_TOKEN_CMD --repos "$name" 2>/dev/null)" || return 1
  else
    json="$(node "$dir/scripts/github-app-token.mjs" --repos "$name" 2>/dev/null)" || return 1
  fi
  tok="$(printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).token||"")}catch{}})')"
  [ -n "$tok" ] || return 1
  b64="$(printf 'x-access-token:%s' "$tok" | base64 | tr -d '\n')"
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.https://github.com/.extraheader" GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $b64" \
    git -C "$dir" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 fetch --quiet origin >/dev/null 2>&1
}
