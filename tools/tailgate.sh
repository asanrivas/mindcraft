#!/bin/bash
# Live combined view of Andy + the Minecraft server. Ctrl-C to stop.
#
#   tailgate            everything (bot log + server console)
#   tailgate bot        just Andy's brain (commands, VERIFIED lines, mode activity)
#   tailgate server     just the server console (joins, deaths, chat, warnings)
#   tailgate chat       just in-game chat and Andy's replies
#
# Colours: cyan = bot, yellow = server, red = anything alarming.

BOT_LOG=/home/asanrivas/mindcraft/logs/service.log
C_BOT=$'\033[36m'; C_SRV=$'\033[33m'; C_ALERT=$'\033[1;31m'; C_END=$'\033[0m'

# -u is load-bearing: without it sed buffers and the "live" tail shows nothing for minutes.
alert() { sed -uE "s/(.*[Ee]rror.*|.*death.*|.*[Dd]rown.*|.*slain.*|.*fell.*|.*rubber-band.*|.*disconnect.*)/${C_ALERT}\1${C_END}/"; }
# The server console embeds cursor-control junk (>....[K) and our own mc calls spam RCON
# thread churn - strip both or the view is unreadable.
srv_clean() { stdbuf -oL tr -d '\r' | sed -uE 's/^[>.]*\x1b\[K//' | grep --line-buffered -viE "Thread RCON Client|RCON Listener"; }

case "${1:-all}" in
  bot)
    exec tail -fn20 "$BOT_LOG" | grep --line-buffered -viE "IdleBehavior|Cleanup" | alert ;;
  server)
    docker logs -f --tail 20 geyser-minecraftbe-1 2>&1 | srv_clean | alert ; exit ;;
  chat)
    docker logs -f --tail 5 geyser-minecraftbe-1 2>&1 | grep --line-buffered -E "<|joined|left|whispers" &
    tail -fn5 "$BOT_LOG" | grep --line-buffered -E "full response|received message" &
    wait ;;
  all|*)
    tail -fn10 "$BOT_LOG" | grep --line-buffered -viE "IdleBehavior|Cleanup|^\s*$" \
      | sed -u "s/^/${C_BOT}[bot]${C_END} /" | alert &
    docker logs -f --tail 10 geyser-minecraftbe-1 2>&1 | srv_clean \
      | grep --line-buffered -viE "Running AutoCompaction|Saving|ThreadedAnvil" \
      | sed -u "s/^/${C_SRV}[srv]${C_END} /" | alert &
    trap 'kill 0' INT TERM
    wait ;;
esac
