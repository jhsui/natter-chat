#!/usr/bin/env bash
# PostToolUse hook: after Claude Code edits a .ts or .tsx file, type-check the project.
# Exit code 2 sends the errors back to Claude so it fixes them before moving on.

file=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).tool_input?.file_path??"")}catch{}})')

case "$file" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

cd "$CLAUDE_PROJECT_DIR" || exit 0

if ! out=$(npm run typecheck --silent 2>&1); then
  echo "Type check failed after editing $file:" >&2
  echo "$out" | tail -30 >&2
  exit 2
fi

exit 0
