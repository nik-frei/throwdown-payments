// Share card: a 1200×630 PNG of the matchup, used as the Open Graph / X card
// image. Rendered with satori (HTML-ish → SVG) and resvg (SVG → PNG).
const fs = require("fs");
const path = require("path");
const satori = require("satori").default;
const { Resvg } = require("@resvg/resvg-js");

const fonts = [
  { name: "Inter", data: fs.readFileSync(path.join(__dirname, "..", "fonts", "Inter-Regular.otf")), weight: 400, style: "normal" },
  { name: "Inter", data: fs.readFileSync(path.join(__dirname, "..", "fonts", "Inter-Bold.otf")), weight: 700, style: "normal" },
  { name: "Inter", data: fs.readFileSync(path.join(__dirname, "..", "fonts", "Inter-Black.otf")), weight: 900, style: "normal" },
];

const money = (c) => "$" + Math.round(c / 100).toLocaleString("en-US");
const h = (type, props = {}, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } });

// Headshot from an X handle via unavatar; falls back to initials on any failure.
async function headshot(handle, name) {
  if (handle) {
    try {
      const res = await fetch(`https://unavatar.io/x/${encodeURIComponent(handle)}?fallback=false`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        const type = res.headers.get("content-type") || "image/jpeg";
        return { src: `data:${type};base64,${buf.toString("base64")}` };
      }
    } catch (_) { /* fall through */ }
  }
  const initials = name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return { initials };
}

function avatarNode(pic, size) {
  const base = { width: size, height: size, borderRadius: size, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", border: "6px solid #1b1b22" };
  if (pic.src) {
    return h("div", { style: base }, h("img", { src: pic.src, width: size, height: size, style: { objectFit: "cover", width: size, height: size } }));
  }
  return h("div", { style: { ...base, background: "#23232c", color: "#9a9aa8", fontSize: size * 0.36, fontWeight: 700 } }, pic.initials);
}

async function render(m) {
  const [a, b] = await Promise.all([headshot(m.a_handle, m.a_name), headshot(m.b_handle, m.b_name)]);
  const pct = Math.min(100, Math.round((m.pledged_cents / m.target_cents) * 100));
  const funded = ["funded", "accepted", "scheduled", "recorded"].includes(m.status);
  const label = m.status === "recorded" ? "RECORDED" : m.status === "scheduled" ? "SCHEDULED" : m.status === "accepted" ? "IT'S ON" : funded ? "FUNDED" : m.status === "expired" ? "EXPIRED" : `${pct}% FUNDED`;

  // satori sizes boxes content-box, so the padded frame is an explicitly sized inner div.
  const tree = h("div", { style: { width: 1200, height: 630, display: "flex", background: "#0b0b0f", color: "#f4f4f6", fontFamily: "Inter" } },
    h("div", { style: { width: 1072, height: 518, margin: "56px 64px", display: "flex", flexDirection: "column" } },
    // top row: wordmark + status chip
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
      h("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
        h("div", { style: { width: 14, height: 14, background: "#ff3b3b", borderRadius: 3 } }),
        h("div", { style: { fontSize: 26, fontWeight: 900, letterSpacing: -1 } }, "THROWDOWN")),
      h("div", { style: { fontSize: 20, fontWeight: 700, letterSpacing: 2, color: funded ? "#0b0b0f" : "#ff3b3b", background: funded ? "#ff3b3b" : "transparent", border: "2px solid #ff3b3b", padding: "8px 16px", borderRadius: 999 } }, label)),
    // middle: A vs B
    h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", gap: 48, marginTop: 36 } },
      h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 14, width: 360 } },
        avatarNode(a, 180),
        h("div", { style: { fontSize: 30, fontWeight: 700, textAlign: "center" } }, m.a_name)),
      h("div", { style: { fontSize: 64, fontWeight: 900, color: "#ff3b3b", letterSpacing: -2 } }, "VS"),
      h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 14, width: 360 } },
        avatarNode(b, 180),
        h("div", { style: { fontSize: 30, fontWeight: 700, textAlign: "center" } }, m.b_name))),
    // question
    h("div", { style: { fontSize: 28, color: "#c9c9d2", textAlign: "center", marginTop: 28, lineHeight: 1.3, maxHeight: 76, overflow: "hidden" } }, m.question),
    // bottom: pledged / target + bar
    h("div", { style: { display: "flex", flexDirection: "column", marginTop: "auto", gap: 12 } },
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: 10 } },
          h("div", { style: { fontSize: 44, fontWeight: 900, letterSpacing: -1 } }, money(m.pledged_cents)),
          h("div", { style: { fontSize: 22, color: "#8c8c9a" } }, `pledged by ${m.backer_count} backer${m.backer_count === 1 ? "" : "s"}`)),
        h("div", { style: { fontSize: 22, color: "#8c8c9a" } }, `target ${money(m.target_cents)}`)),
      h("div", { style: { display: "flex", height: 14, background: "#1b1b22", borderRadius: 999, overflow: "hidden" } },
        h("div", { style: { width: `${Math.max(pct, 1.5)}%`, height: 14, background: "#ff3b3b" } })))));

  const svg = await satori(tree, { width: 1200, height: 630, fonts });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng();
  return png;
}

module.exports = { render };
