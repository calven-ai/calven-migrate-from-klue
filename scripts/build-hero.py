"""Builds docs/assets/hero-{light,dark}.svg, the animated README hero.

Run from the repo root with the workspace brand library next door:
  python3 scripts/build-hero.py ../calven-ai-workspace/brand/library
Colours are the brand tokens; the Calven wordmark paths are copied from the
library's wordmark SVGs. No third-party logos.
"""
import re
import sys
from pathlib import Path

LIB = Path(sys.argv[1] if len(sys.argv) > 1 else "../calven-ai-workspace/brand/library")
OUT = Path("docs/assets")

THEMES = {
    "light": dict(text="#0A0A0A", text2="#6B6B78", panel="#F9FAFC", border="#E4E4EA", card="#FFFFFF", line="#C9C9D3", wordmark="wordmark-on-light.svg"),
    "dark": dict(text="#F9FAFC", text2="#A3A3A3", panel="#141414", border="#262626", card="#0A0A0A", line="#3A3A3A", wordmark="wordmark-on-dark.svg"),
}
FONT = "Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"


def wordmark_paths(name):
    svg = (LIB / "logos" / name).read_text()
    inner = re.search(r"<svg[^>]*>(.*)</svg>", svg, re.S).group(1)
    inner = re.sub(r"<rect[^>]*/>", "", inner, count=1)  # drop the background
    return inner.strip()


def card(x, y, t, accent=False):
    stroke = "url(#grad)" if accent else t["border"]
    return f"""<g transform="translate({x} {y})">
      <rect width="56" height="40" rx="6" fill="{t['card']}" stroke="{stroke}" stroke-width="{2 if accent else 1.5}"/>
      <rect x="9" y="10" width="30" height="5" rx="2.5" fill="{t['text2']}"/>
      <rect x="9" y="20" width="38" height="4" rx="2" fill="{t['line']}"/>
      <rect x="9" y="28" width="24" height="4" rx="2" fill="{t['line']}"/>
    </g>"""


def build(theme):
    t = THEMES[theme]
    W, H = 960, 300
    panels = [(30, "Your CI tool", "cards and battlecards"), (360, "Your files", "Markdown and JSON, on your machine"), (690, "", "bring them into Calven")]
    parts = []
    for x, title, sub in panels:
        parts.append(f'<rect x="{x}" y="40" width="240" height="200" rx="16" fill="{t["panel"]}" stroke="{t["border"]}" stroke-width="1.5"/>')
        if title:
            parts.append(f'<text x="{x + 120}" y="78" text-anchor="middle" font-size="20" font-weight="600" fill="{t["text"]}">{title}</text>')
        parts.append(f'<text x="{x + 120}" y="270" text-anchor="middle" font-size="14" fill="{t["text2"]}">{sub}</text>')

    # stack of cards in the source tool
    for i, (dx, dy) in enumerate([(-36, 0), (24, 0), (-36, 52), (24, 52)]):
        parts.append(card(150 + dx - 28, 104 + dy, t))
    # file chips in the middle
    for i, label in enumerate([".md", ".json"]):
        x = 410 + i * 76
        parts.append(f'<g transform="translate({x} 120)"><path d="M0 6a6 6 0 0 1 6-6h34l14 14v50a6 6 0 0 1-6 6H6a6 6 0 0 1-6-6z" fill="{t["card"]}" stroke="{t["border"]}" stroke-width="1.5"/><text x="27" y="48" text-anchor="middle" font-size="15" font-weight="600" fill="{t["text"]}">{label}</text></g>')
    # Calven wordmark: content box is 80..455 x 80..160 in a 535x240 canvas
    parts.append(f'<g transform="translate(731 123) scale(0.42) translate(-80 -80)">{wordmark_paths(t["wordmark"])}</g>')

    # connectors with a moving dash
    for x1, x2 in [(278, 352), (608, 682)]:
        parts.append(f'<line class="flow" x1="{x1}" y1="140" x2="{x2}" y2="140" stroke="url(#lineGrad)" stroke-width="3" stroke-dasharray="6 8" stroke-linecap="round"/>')
        parts.append(f'<path d="M{x2 - 8} 133l9 7-9 7" fill="none" stroke="#2E8BE7" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>')

    # travelling cards
    parts.append(f'<g class="leg1">{card(222, 120, t, accent=True)}</g>')
    parts.append(f'<g class="leg2">{card(552, 120, t, accent=True)}</g>')

    css = """
    text { font-family: FONT_STACK; }
    .flow { animation: dash 1.2s linear infinite; }
    .leg1 { animation: leg1 4s ease-in-out infinite; opacity: 0; }
    .leg2 { animation: leg2 4s ease-in-out infinite; opacity: 0; }
    @keyframes dash { to { stroke-dashoffset: -28; } }
    @keyframes leg1 {
      0% { transform: translateX(0); opacity: 0; }
      8% { opacity: 1; }
      34% { transform: translateX(110px); opacity: 1; }
      44%, 100% { transform: translateX(120px); opacity: 0; }
    }
    @keyframes leg2 {
      0%, 46% { transform: translateX(0); opacity: 0; }
      54% { opacity: 1; }
      78% { transform: translateX(95px); opacity: 1; }
      86%, 100% { transform: translateX(102px); opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .flow, .leg1, .leg2 { animation: none; }
    }
    """.replace("FONT_STACK", FONT)

    body = "\n  ".join(parts)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="title desc">
  <title id="title">Export from your CI tool to your own files, then into Calven</title>
  <desc id="desc">Cards and battlecards move from a competitive intelligence tool to Markdown and JSON files on your machine, then into Calven.</desc>
  <defs>
    <linearGradient id="grad" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#D3B8E1"/><stop offset="1" stop-color="#2E8BE7"/></linearGradient>
    <linearGradient id="lineGrad" gradientUnits="userSpaceOnUse" x1="270" x2="690" y1="0" y2="0"><stop offset="0" stop-color="#D3B8E1"/><stop offset="1" stop-color="#2E8BE7"/></linearGradient>
    <style>{css}</style>
  </defs>
  {body}
</svg>
"""


OUT.mkdir(parents=True, exist_ok=True)
for theme in THEMES:
    path = OUT / f"hero-{theme}.svg"
    path.write_text(build(theme))
    print(path, path.stat().st_size, "bytes")
