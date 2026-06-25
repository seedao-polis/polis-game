#!/usr/bin/env bash
# Fetch the open_ids for a new bot's configs/lark.json profile entry.
# Given a lark-cli profile, reads the bot's open_id (bot/v3/info, bot identity) and the logged-in
# operator's open_id (auth status, user identity), then prints a ready-to-edit profile block.
# App id and tenant key are left as placeholders (tenant key is reusable within one enterprise).
# Usage: fetch-bot-ids.sh <lark-cli-profile> [profile-key] [bot-name]
set -euo pipefail

profile="${1:?用法: fetch-bot-ids.sh <lark-cli-profile> [profile-key] [bot-name]}"
profile_key="${2:-$profile}"
bot_name="${3:-bot}"

# Extract a dotted JSON path from stdin using node (bundled with the project runtime).
json_path() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v&&v[k];process.stdout.write(v==null?"":String(v))}catch{process.stdout.write("")}})' "$1"
}

bot_open_id="$(lark-cli --profile "$profile" api GET /open-apis/bot/v3/info --as bot | json_path bot.open_id)"
user_open_id="$(lark-cli --profile "$profile" auth status | json_path identities.user.openId)"

if [ -z "$bot_open_id" ]; then
  echo "取不到 bot open_id：确认机器人能力已启用、版本已发布（bot/v3/info 需要 --as bot）。" >&2
  exit 1
fi
if [ -z "$user_open_id" ]; then
  echo "取不到 user open_id：确认已 lark-cli --profile $profile auth login --domain im。" >&2
  exit 1
fi

cat <<EOF
# 贴进 configs/lark.json 的 "profiles" 里（appId / tenantKey 自己填）：
"$profile_key": {
  "larkProfile": "$profile",
  "appId": "<cli_xxx>",
  "tenantKey": "<企业 tenant_key，同企业可复用现有 profile 的值>",
  "userOpenId": "$user_open_id",
  "botOpenId": "$bot_open_id",
  "botName": "$bot_name"
}
EOF
