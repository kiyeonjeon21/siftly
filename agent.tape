# VHS tape: siftly used FROM a coding agent (Claude Code headless).
# Render: vhs agent.tape  ->  docs/agent.gif
# Requires: the siftly MCP server configured (.mcp.json) + claude CLI.

Output docs/agent.gif

Require claude

Set Shell bash
Set FontSize 18
Set Width 1240
Set Height 420
Set Padding 24
Set TypingSpeed 45ms

Sleep 800ms

Type `claude -p "Top 3 Hacker News stories today, one line each — use siftly." --allowedTools mcp__siftly__siftly_hackernews`
Sleep 500ms
Enter
Wait
Sleep 3s
