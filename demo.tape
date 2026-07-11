# VHS tape for the siftly CLI demo GIF.  Render: vhs demo.tape  ->  docs/demo.gif
# (warm the cache first so it renders fast: run the commands below once.)

Output docs/demo.gif

Require bun

Set Shell bash
Set FontSize 18
Set Width 1200
Set Height 820
Set Padding 24
Set TypingSpeed 40ms

Hide
Type "alias siftly='bun run src/cli.ts' && clear" Enter
Show

Type "# siftly — pull HN / YouTube / X / RSS into agent-ready text (your agent summarizes)"
Enter
Sleep 1500ms

Type "siftly x --news 'AI' --posts 1 --no-hint"
Sleep 500ms
Enter
Sleep 3500ms

Type "siftly yt --channel @aiDotEngineer --list --limit 3"
Sleep 500ms
Enter
Sleep 3s

Type "siftly x --user OpenAI --posts 2 --no-hint"
Sleep 500ms
Enter
Sleep 3s

Type "siftly cache stats"
Sleep 500ms
Enter
Sleep 2500ms

Type "# ...and it's an MCP server: in Claude Desktop just ask 'what's on HN today?'"
Enter
Sleep 2500ms
