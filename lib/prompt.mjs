// Prompt construction for the "✨ 仕上げる" (refine) flow.
import { arrowPoints, lookupFn, strokeBounds } from "../core/geometry.mjs";

const MAX_LINES = 150;

const r = (n) => Math.round(n);

export function describeElements(doc) {
    const lookup = lookupFn(doc.elements);
    const lines = doc.elements.slice(0, MAX_LINES).map((el) => {
        const label = el.label ? ` "${el.label.replace(/\s+/g, " ").slice(0, 60)}"` : "";
        if (el.type === "arrow") {
            const points = arrowPoints(el, lookup);
            const a = points[0];
            const b = points[points.length - 1];
            const from = el.from ? `#${el.from}` : `(${r(a.x)},${r(a.y)})`;
            const to = el.to ? `#${el.to}` : `(${r(b.x)},${r(b.y)})`;
            return `- #${el.id} arrow ${from} -> ${to}${label}`;
        }
        return `- #${el.id} ${el.type} x=${r(el.x)} y=${r(el.y)} w=${r(el.w)} h=${r(el.h)}${label}`;
    });
    if (doc.elements.length > MAX_LINES) lines.push(`- ... ${doc.elements.length - MAX_LINES} more (call get_diagram for all)`);
    return lines.length ? lines.join("\n") : "(none)";
}

export function describeStrokes(strokes) {
    const lines = strokes.slice(0, MAX_LINES).map((stroke) => {
        const b = strokeBounds(stroke);
        return `- ${stroke.id}: bbox x=${r(b.x)} y=${r(b.y)} w=${r(b.w)} h=${r(b.h)}, ${stroke.points.length} pts, color ${stroke.color}`;
    });
    if (strokes.length > MAX_LINES) lines.push(`- ... ${strokes.length - MAX_LINES} more`);
    return lines.length ? lines.join("\n") : "(none)";
}

const SCHEMA = `Element schema:
- node: {"id", "type": "rect"|"rounded"|"ellipse"|"diamond"|"cylinder"|"text"|"frame", "x", "y", "w", "h", "label", "style"?: {"stroke", "fill", "text", "dashed", "fontSize"}}
- arrow: {"id", "type": "arrow", "from": nodeId, "to": nodeId, "label"?, "style"?: {"dashed", "head": "end"|"start"|"both"|"none", "route": "straight"|"elbow"}} (give x1,y1 / x2,y2 only for ends not attached to a node)
- "frame" is a labelled container (e.g. a cloud, VNet, subsystem) drawn behind other nodes; its label sits at the top-left.`;

export function buildRefinePrompt({ instanceId, jobId, doc, strokes, frame, instruction }) {
    const hasStrokes = strokes.length > 0;
    const instructionLine = instruction?.trim() ? `User instruction: "${instruction.trim()}"` : "User instruction: (none)";
    const mapping = frame
        ? `Image pixel (px, py) maps to world (${frame.x} + px / ${frame.scale}, ${frame.y} + py / ${frame.scale}). Grid lines every 100 world units are labelled with their world coordinate.`
        : "Grid lines every 100 world units are labelled with their world coordinate.";
    const call = `invoke_canvas_action with instanceId "${instanceId}", actionName "apply_changes", input {"refineId": "${jobId}", "add": [...], "update": [...], "delete": [...]}`;

    const intro = hasStrokes
        ? `[shape canvas] The user pressed "✨ 仕上げる" (refine) on the shape whiteboard. Convert their pending freehand sketch into clean, editable diagram elements.`
        : `[shape canvas] The user pressed "✨ 仕上げる" (refine) on the shape whiteboard with an instruction but no new sketch. Apply the instruction to the existing diagram.`;

    const steps = hasStrokes
        ? `Steps:
1. Interpret ONLY the pending strokes (full color in the image). Existing elements are drawn faded with blue #id tags; keep their ids, positions and sizes unless the sketch or instruction clearly changes them.
2. Map sketched shapes to types: box -> rect (clearly rounded corners -> rounded), circle/oval -> ellipse, diamond -> diamond, cylinder/can -> cylinder, a large box enclosing other shapes -> frame, handwriting on its own -> text. Handwriting inside a shape is that shape's label; handwriting next to a line is the arrow's label.
3. A line or arrow between two shapes (new or existing) -> arrow with from/to ids; arrowhead side decides direction (no head -> style.head "none", heads at both ends -> "both"). A scribble or X over an existing element means delete it; writing over an existing element means update its label.
4. Place elements in world coordinates where they were drawn. Snap x, y, w, h to multiples of 20, tidy sizes (make similar shapes the same size), align shapes that are roughly in a row or column, and make each node wide enough for its label.
5. Transcribe handwriting exactly in its original language (Japanese stays Japanese). If a word is illegible, make your best guess from context.
6. New ids: short kebab-case from the label (e.g. "api-gateway"). Pen color is just ink; use default styles unless the instruction asks otherwise.
7. Call ${call} exactly once. The pending strokes are consumed automatically when you pass refineId.
8. Then reply with one short sentence in the user's language summarizing the change. Do not open other canvases, run tools, or edit files.`
        : `Steps:
1. Apply the instruction to the existing diagram (re-layout, restyle, add or remove elements as requested). Keep ids of elements you keep.
2. Snap x, y, w, h to multiples of 20 and keep labels in their original language.
3. Call ${call} exactly once (for a full restructure you may instead call actionName "replace_diagram" with {"elements": [...]}).
4. Then reply with one short sentence in the user's language summarizing the change. Do not open other canvases, run tools, or edit files.`;

    return [
        intro,
        "",
        `Canvas instanceId: "${instanceId}". Diagram title: "${doc.title}".`,
        `The attached image shows the current canvas. ${mapping}`,
        instructionLine,
        "",
        "Existing elements:",
        describeElements(doc),
        "",
        "Pending strokes:",
        describeStrokes(strokes),
        "",
        steps,
        "",
        SCHEMA,
    ].join("\n");
}

export function buildDisplayPrompt({ strokes, instruction }) {
    const text = instruction?.trim();
    if (!strokes.length) return `✨ shape: 「${text}」を図に反映して`;
    return text ? `✨ shape: スケッチを図に仕上げて（${text}）` : "✨ shape: スケッチを図に仕上げて";
}
