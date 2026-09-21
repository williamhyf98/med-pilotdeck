/** Validate persisted/captured evidence with a budget independent of chat text. */
export function normalizeAttachmentEvidence(value) {
    if (!Array.isArray(value))
        return [];
    let remaining = 64_000;
    return value.slice(0, 64).flatMap((item) => {
        if (!item || typeof item.sourceId !== "string"
            || !["read_text", "medical_parser_summary"].includes(item.sourceKind)
            || !Array.isArray(item.chunks))
            return [];
        const chunks = [];
        let omitted = Math.max(0, Number(item.omittedChars) || 0);
        for (const chunk of item.chunks) {
            if (typeof chunk !== "string")
                continue;
            const kept = chunk.slice(0, remaining);
            if (kept)
                chunks.push(kept);
            omitted += chunk.length - kept.length;
            remaining -= kept.length;
        }
        return [{ sourceId: item.sourceId, sourceKind: item.sourceKind, chunks,
                originalChars: Math.max(0, Number(item.originalChars) || 0), omittedChars: omitted,
                possiblyPartial: Boolean(item.possiblyPartial) || omitted > 0 }];
    });
}
