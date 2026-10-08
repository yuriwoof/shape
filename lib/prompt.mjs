// Prompt construction for the "✨ 仕上げる" (refine) flow.
import { arrowPoints, lookupFn, strokeBounds } from "../core/geometry.mjs";
import { AZURE_SERVICES } from "../core/azure-icons.mjs";

const MAX_LINES = 150;

const r = (n) => Math.round(n);

export function describeElements(doc) {
    const lookup = lookupFn(doc.elements);
    const lines = doc.elements.slice(0, MAX_LINES).map((el) => {
        const label = el.label ? ` "${el.label.replace(/\s+/g, " ").slice(0, 60)}"` : "";
        if (el.type === "arrow") {
            const points = arrowPoints(el, lookup, doc.elements);
            const a = points[0];
            const b = points[points.length - 1];
            const from = el.from ? `#${el.from}` : `(${r(a.x)},${r(a.y)})`;
            const to = el.to ? `#${el.to}` : `(${r(b.x)},${r(b.y)})`;
            return `- #${el.id} arrow ${from} -> ${to}${label}`;
        }
        return `- #${el.id} ${el.type}${el.service ? ` service=${el.service}` : ""} x=${r(el.x)} y=${r(el.y)} w=${r(el.w)} h=${r(el.h)}${label}`;
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
- node: {"id", "type": "rect"|"rounded"|"ellipse"|"diamond"|"cylinder"|"text"|"frame"|"azure-service", "x", "y", "w", "h", "label", "style"?: {"stroke", "fill", "text", "dashed", "fontSize"}}
- azure-service: also requires "service": one of the catalog IDs below; the official icon and product name render automatically. "label" can add a workload-specific annotation.
- arrow: {"id", "type": "arrow", "from": nodeId, "to": nodeId, "label"?, "style"?: {"dashed", "head": "end"|"start"|"both"|"none", "route": "straight"|"elbow"}} (give x1,y1 / x2,y2 only for ends not attached to a node)
- "frame" is a labelled container (e.g. a cloud, VNet, subsystem) drawn behind other nodes; its label sits at the top-left.`;

const SEMANTIC_GUIDANCE = `Semantic sketch interpretation:
- Decide what each sketched symbol represents before choosing an element type. Use its visible symbol, handwriting inside or beside it, the user instruction, nearby arrows, and the surrounding diagram together. Meaning takes priority over copying the rough outline literally.
- Map an unambiguous person, stick figure, user, customer, or operator to an ellipse with the exact readable role/name as its label (for example "ユーザー" or "Admin").
- Map an unambiguous VM, virtual machine, 仮想マシン, server, or compute host to a rounded node with its exact readable name. This includes Azure Virtual Machine because it is not in the official icon catalog; never replace it with another Azure service icon.
- Map a database or data store to a cylinder, a decision to a diamond, a labelled boundary or group to a frame, and standalone writing to text when those meanings are clear.
- Do not infer a specific concept from a plain unlabeled box alone. If the meaning is uncertain, preserve the geometry using the ordinary shape mapping instead of inventing a label or technology.
- If a symbol is unambiguous but has no readable label, use a short neutral label in the sketch's language (for example "User" or "ユーザー"), not an invented product or implementation detail.`;

const AZURE_GUIDANCE = `Azure architecture rules (apply ONLY if the instruction, existing Azure service nodes, or readable sketch explicitly identifies Azure or a specific Azure product; generic "web", "DB" or cloud sketches stay generic):
- Official icon catalog (ID: product): ${AZURE_SERVICES.map(({ id, name }) => `${id}: ${name}`).join("; ")}.
- Use azure-service only for an unambiguous catalog match. For an unsupported or uncertain service, use a generic node with its stated product name; never substitute a different Azure service. Preserve existing node IDs and labels when refining.
- Use consistent sizes, aligned columns, at least 40 world units between separate nodes, and at least 30 units of frame padding around contained nodes. Label actual boundaries (such as VNet and subnet) with frames; place nested frames entirely inside the parent. Use one-way labelled arrows for non-obvious flows, preferably elbow routes when they are clearer. Keep arrows out of unrelated nodes, avoid line crossings, and leave enough whitespace for labels. Do not invent infrastructure or assert connectivity absent from the sketch or instruction.
- Model network boundaries accurately: a PaaS service reached through a private endpoint is outside the VNet/subnet frame; its private endpoint is inside the subnet. Do not put the PaaS service inside the subnet.
- The icons must remain unmodified and their official product names remain visible. The user can edit nodes, connections and frames after refinement.`;

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
2. First infer the meaning of each symbol using the semantic rules below. When a meaning is not clear, fall back to its geometry: box -> rect (clearly rounded corners -> rounded), circle/oval -> ellipse, diamond -> diamond, cylinder/can -> cylinder, a large box enclosing other shapes -> frame, handwriting on its own -> text. Handwriting inside a shape is that shape's label; handwriting next to a line is the arrow's label.
3. A line or arrow between two shapes (new or existing) -> arrow with from/to ids; arrowhead side decides direction (no head -> style.head "none", heads at both ends -> "both"). A scribble or X over an existing element means delete it; writing over an existing element means update its label.
4. Place elements in world coordinates where they were drawn. Snap x, y, w, h to multiples of 20, tidy sizes (make similar shapes the same size), align shapes that are roughly in a row or column, and make each node wide enough for its label.
5. Transcribe handwriting exactly in its original language (Japanese stays Japanese). If a word is illegible, make your best guess from context, but do not invent a specific technology when the evidence is ambiguous.
6. New ids: short kebab-case from the label (e.g. "api-gateway"). Pen color is just ink; use default styles unless the instruction asks otherwise. Apply the Azure rules below only on clear evidence.
7. Call ${call} exactly once. The pending strokes are consumed automatically when you pass refineId.
8. Then reply with one short sentence in the user's language summarizing the change. Do not open other canvases, run tools, or edit files.`
        : `Steps:
1. Apply the instruction to the existing diagram (re-layout, restyle, add or remove elements as requested). Keep ids of elements you keep. Apply the Azure rules below only on clear evidence.
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
        "",
        SEMANTIC_GUIDANCE,
        "",
        AZURE_GUIDANCE,
    ].join("\n");
}

export function buildDisplayPrompt({ strokes, instruction }) {
    const text = instruction?.trim();
    if (!strokes.length) return `✨ shape: 「${text}」を図に反映して`;
    return text ? `✨ shape: スケッチを図に仕上げて（${text}）` : "✨ shape: スケッチを図に仕上げて";
}
