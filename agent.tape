# VHS tape: siftly used INSIDE the Claude Code TUI (interactive).
# A two-turn conversation where the agent calls siftly for Hacker News, then to
# summarize a YouTube talk. You can see "Called siftly" in the UI each time.
# Render: vhs agent.tape  ->  docs/agent.gif
# Requires: claude logged in, with the siftly MCP server configured (.mcp.json).
# Warm siftly caches first so tool calls are snappy.

Output "docs/agent.gif"

Require claude

Set Shell bash
Set FontSize 16
Set Width 1240
Set Height 840
Set Padding 20
Set TypingSpeed 40ms

Type "claude --dangerously-skip-permissions"
Enter
Sleep 6s

Type "Top 2 Hacker News stories today, one line each - use siftly."
Sleep 500ms
Enter
Sleep 22s

Type "Now summarize this talk in 2 bullets: https://youtu.be/GdvKNwMcfd0"
Sleep 500ms
Enter
Sleep 30s
