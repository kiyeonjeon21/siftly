# VHS tape: siftly used FROM a coding agent (Claude Code headless).
# Three natural-language questions, each answered by calling a siftly MCP tool
# (Hacker News, X news, and a YouTube transcript).
# Render: vhs agent.tape  ->  docs/agent.gif
# Requires: the siftly MCP server configured (.mcp.json) + claude CLI.
# Warm the caches first so tool calls are fast.

Output docs/agent.gif

Require claude

Set Shell bash
Set FontSize 17
Set Width 1260
Set Height 780
Set Padding 22
Set TypingSpeed 30ms

Sleep 800ms

Type `claude -p "Top 2 Hacker News stories today, one line each — use siftly." --allowedTools mcp__siftly__siftly_hackernews`
Sleep 400ms
Enter
Wait@60s
Sleep 2500ms

Type `claude -p "In 2 bullets, what's the AI news on X right now? Use siftly." --allowedTools mcp__siftly__siftly_x_news`
Sleep 400ms
Enter
Wait@60s
Sleep 2500ms

Type `claude -p "Summarize this talk in 2 bullets: https://youtu.be/GdvKNwMcfd0 — use siftly." --allowedTools mcp__siftly__siftly_youtube`
Sleep 400ms
Enter
Wait@60s
Sleep 3s
