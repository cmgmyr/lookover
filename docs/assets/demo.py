# Generates docs/assets/demo.svg: a looping terminal recording as pure SVG+CSS.
import html
W, H = 680, 402; LH = 19; X0 = 22; Y0 = 46; FS = 13; CW = 7.85  # char width at 13px JetBrains Mono
BG = "#10151C"; FRAME = "#222B36"; INK = "#E6EDF3"; DIM = "#8B98A5"; ORCHID = "#B86BF0"; AMBER = "#F5A524"
LOOP = 25.0
# (kind, text, start_s) kind: cmd (typed, orchid prompt), cont (typed continuation line), out (fades, dim),
# note (fades, dim comment), done (fades, orchid)
script = [
  ("cmd",  'lookover add --title "Try the new header on mobile" \\', 0.6),
  ("cont", "--details-file steps.md --url http://127.0.0.1:3000 --ref todo-412", 3.0),
  ("out",  "added #42 to novelhood", 6.0),
  ("note", "# a moment later, in the page: you tap Needs work and write two sentences", 7.4),
  ("cmd",  "lookover feedback --json", 9.4),
  ("out",  "[", 10.9),
  ("out",  "  {", 11.1),
  ("out",  '    "id": 42,', 11.3),
  ("out",  '    "title": "Try the new header on mobile",', 11.5),
  ("out",  '    "verdict": "needs-work",', 11.7),
  ("out",  '    "feedback": "The header jumps when I scroll back up.', 11.9),
  ("out",  '      The menu sheet covers the search box.",', 12.1),
  ("out",  "    \u2026", 12.3),
  ("out",  "  }", 12.5),
  ("out",  "]", 12.7),
  ("cmd",  'lookover process 42 --note "todo-412: fixed the mobile header spacing"', 14.6),
  ("out",  "processed #42", 17.9),
  ("done", "Card #42 processed. Queue: 0 open.", 19.4),
]
def pct(t): return f"{t/LOOP*100:.4f}%"
css = ["text{font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;white-space:pre}",
       "@keyframes bl{0%,49.9%{opacity:1}50%,100%{opacity:0}}"]
body = []
y = Y0
for i, (kind, text, t) in enumerate(script):
    cls = f"c{i}"
    if kind in ("cmd", "cont"):
        prefix = "$ " if kind == "cmd" else "  "
        pcolor = ORCHID
        n = len(text); dur = max(0.35, n * 0.04); w = n * CW
        # reveal via a clip rect that widens in character steps
        css.append(f"@keyframes k{i}{{0%{{width:0}}{pct(t)}{{width:0;animation-timing-function:steps({n},end)}}{pct(t+dur)}{{width:{w:.2f}px}}100%{{width:{w:.2f}px}}}}")
        css.append(f".{cls}{{animation:k{i} {LOOP}s linear infinite}}")
        css.append(f"@keyframes p{i}{{0%{{opacity:0}}{pct(max(0,t-0.4))}{{opacity:0}}{pct(max(0,t-0.39))}{{opacity:1}}100%{{opacity:1}}}}")
        css.append(f".p{i}{{animation:p{i} {LOOP}s linear infinite}}")
        px = X0 + 2 * CW
        body.append(f'<g class="p{i}"><text x="{X0}" y="{y}" font-size="{FS}" fill="{pcolor}">{prefix}</text>'
                    f'<clipPath id="cp{i}"><rect class="{cls}" x="{px}" y="{y-14}" height="{LH}" width="0"/></clipPath>'
                    f'<text x="{px}" y="{y}" font-size="{FS}" fill="{INK}" clip-path="url(#cp{i})">{html.escape(text, quote=False)}</text></g>')
    else:
        color = {"out": DIM, "note": DIM, "done": ORCHID}[kind]
        css.append(f"@keyframes k{i}{{0%{{opacity:0;transform:translateY(4px)}}{pct(t)}{{opacity:0;transform:translateY(4px);animation-timing-function:cubic-bezier(.23,1,.32,1)}}{pct(t+0.3)}{{opacity:1;transform:translateY(0)}}100%{{opacity:1;transform:translateY(0)}}}}")
        css.append(f".{cls}{{animation:k{i} {LOOP}s linear infinite}}")
        body.append(f'<g class="{cls}"><text x="{X0}" y="{y}" font-size="{FS}" fill="{color}">{html.escape(text, quote=False)}</text></g>')
    y += LH
# fade everything out at the end of the loop
css.append(f"@keyframes fade{{0%{{opacity:1}}{pct(LOOP-1.2)}{{opacity:1}}{pct(LOOP-0.3)}{{opacity:0}}100%{{opacity:0}}}}")
css.append(f".all{{animation:fade {LOOP}s linear infinite}}")
title = "lookover: an agent files a card, you answer on the page, the agent processes the verdict"
svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="t d">'
       f'<title id="t">{title}</title><desc id="d">A terminal. An agent runs lookover add to file a card for the tester and gets card 42 back. A moment later, in the page, the tester taps Needs work and writes two sentences. The agent runs lookover feedback --json and reads the verdict and the paragraph, then runs lookover process with a note naming the work item. The card is processed and the queue is empty.</desc>'
       f'<style>{"".join(css)}</style>'
       f'<rect x="0.5" y="0.5" width="{W-1}" height="{H-1}" rx="10" fill="{BG}" stroke="{FRAME}"/>'
       f'<circle cx="20" cy="18" r="5" fill="#FF5F57"/><circle cx="38" cy="18" r="5" fill="#FEBC2E"/><circle cx="56" cy="18" r="5" fill="#28C840"/>'
       f'<text x="{W/2}" y="22" font-size="11" fill="{DIM}" text-anchor="middle">~/code/novelhood</text>'
       f'<g class="all">{"".join(body)}</g></svg>\n')
import os; open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "demo.svg"), "w").write(svg)
print(len(svg), "bytes")
