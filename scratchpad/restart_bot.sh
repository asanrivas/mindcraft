#!/bin/zsh
# Restart the manually-launched bot (auto_login off) without pkill: a `pkill -f main.js` also
# matches the shell running it, which kills the caller before the restart can happen.
# Pass extra settings as $1, e.g.  restart_bot.sh '"profiles":["./andy.json","./bob.json"]'
# KILL THE PARENTS FIRST, AND WAIT UNTIL THEY ARE ACTUALLY GONE.
#
# `main.js` respawns a dead agent by itself ("Agent process exited with code 1 - Restarting
# agent..."), so killing `init_agent.js` while its parent lives just brings it straight back. And
# a fixed `sleep 4` is not proof: twice this script started a SECOND `main.js` while the first was
# still alive, each with its own MindServer (8080 and 8082) and its own bob. Two clients on one
# account evict each other with `multiplayer.disconnect.duplicate_login`, every kick schedules a
# 5s auto-restart, and the pair crash-loop forever - measured at one join/leave cycle every ~14s.
# ANCHOR THE MATCH AT THE EXECUTABLE. An unanchored grep also matches any SHELL whose command
# line happens to contain the pattern - including the very command that calls this script, if it
# mentions `main.js` in an awk program. That false positive made the guard below refuse to start
# with nothing actually running.
alive() { ps -eo cmd | grep -qE '^[^ ]*/bun (run main\.js|[^ ]*init_agent\.js)'; }
for sig in TERM TERM KILL; do
    alive || break
    for pid in $(ps -eo pid,cmd | awk '$2 ~ /\/bun$/ && /main\.js|init_agent\.js/ {print $1}'); do
        kill -$sig $pid 2>/dev/null
    done
    for i in 1 2 3 4 5 6 7 8 9 10; do alive || break; sleep 1; done
done
if alive; then echo "REFUSING TO START: an agent process is still running" >&2; exit 1; fi
echo "--- restart $(date) ---" >> /home/asanrivas/mindcraft/logs/service.log
cd /home/asanrivas/mindcraft
EXTRA=""
[ -n "$1" ] && EXTRA=",$1"
export SETTINGS_JSON="{\"auto_login\":false,\"idle_disconnect_timeout\":0$EXTRA}"
setsid /home/asanrivas/.bun/bin/bun run main.js >> logs/service.log 2>&1 < /dev/null &
echo "restarted with SETTINGS_JSON=$SETTINGS_JSON"
